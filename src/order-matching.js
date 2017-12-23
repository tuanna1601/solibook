'use strict';

import BigNumber from 'bignumber.js';
import Co from 'co';
import Fawn from 'fawn';
import Mongoose from 'mongoose';

export default class OrderMatching {
  constructor(mongoose, fawn, prefix) {

    // order model
    const Schema = Mongoose.Schema;
    const ObjectId = Schema.Types.ObjectId;
    const order = new Schema({
      limit: {
        type: Number,
        required: true,
      },
      originalVolume: {
        type: String,
        required: true,
      },
      currentVolume: {
        type: String,
        required: true,
      },
      isSelling: {
        type: Boolean,
        default: true,
      },
      status: {
        type: String,
        enum: ['unprocessed', 'processed', 'canceled'],
        required: true,
        default: 'unprocessed',
      },
      userId: {
        type: String,
        required: true,
      },
      created: {
        type: Date,
        default: Date.now,
      }
    });

    order.set('toObject', { getters: true });
    order.set('toJSON', {
      getters: true,
      transform: function (doc, ret) {
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    });
    this.orderModelName = `${prefix}_Order`;
    this.Order = mongoose.model(this.orderModelName, order);

    // marketData model

    const marketData = new Schema({
      sellVolume: {
        type: String,
      },
      sellPrice: {
        type: String,
      },
      buyVolume: {
        type: String,
      },
      buyPrice: {
        type: String,
      },
      matchVolume: {
        type: String,
      },
      matchPrice: {
        type: String,
      },
      created: {
        type: Date,
        default: Date.now,
      },
    });

    this.marketDataModelName = `${prefix}_MarketData`;
    this.MarketData = mongoose.model(this.marketDataModelName, marketData);

    this.task = fawn.Task();
    this.matchNextOrder();
  }

  addHooks(onBeforePlaceOrder = () => { }, onAfterMatched = () => { }, onCancelOrder = () => { }) {
    this.onBeforePlaceOrder = onBeforePlaceOrder;
    this.onAfterMatched = onAfterMatched;
    this.onCancelOrder = onCancelOrder;
  }

  async processOrder(order) {
    try {
      if (!order) {
        return;
      }
      let latestVolume = '';
      let latestPrice = '';
      while (BigNumber(order.currentVolume).greaterThan(0)) {
        const matching = await this.Order
          .findOne({
            currentVolume: {
              $ne: '0',
            },
            status: {
              $ne: 'canceled',
            },
            limit: order.isSelling ?
              {
                $gte: order.limit,
              } :
              {
                $lte: order.limit,
              },
            isSelling: !order.isSelling,
          })
          .sort({
            limit: order.isSelling ? -1 : 1,
          });
        if (!matching) {
          break;
        }
        const volume = BigNumber.min(order.currentVolume, matching.currentVolume).valueOf();
        const price = order.isSelling ? BigNumber.max(order.limit, matching.limit).valueOf() : order.limit;
        latestVolume = volume;
        latestPrice = price;
        this.task
          .update(this.orderModelName, {
            _id: order._id,
          }, {
            currentVolume: BigNumber(order.currentVolume).minus(volume),
          })
          .update(this.orderModelName, {
            _id: matching._id,
          }, {
            currentVolume: BigNumber(matching.currentVolume).minus(volume),
          });
        this.onAfterMatched(this.task, order, matching, volume.valueOf(), price);
        await this.task.run({ useMongoose: true })
          .then((results) => {
            if (results && results[0] && results[0].nModified === 1) {
              order.currentVolume = BigNumber(order.currentVolume).minus(volume);
            }
          });
      }

      // set processed
      await this.Order.update({
        _id: order._id,
      }, {
        status: 'processed',
      });
      // update MarketData
      const latestSellOrder = await this.Order.findOne({
        status: {
          $ne: 'canceled',
        },
        currentVolume: {
          $ne: '0',
        },
        isSelling: true,
      })
        .sort({
          limit: 1,
        })
        .lean();

      const latestBuyOrder = await this.Order.findOne({
        status: {
          $ne: 'canceled',
        },
        currentVolume: {
          $ne: '0'
        },
        isSelling: false,
      })
        .sort({
          limit: -1,
        })
        .lean();

      const latestMarketData = await this.getLatestMarketData();

      if (!latestVolume && !latestPrice && latestMarketData) {
        latestVolume = latestMarketData.matchVolume,
          latestPrice = latestMarketData.matchPrice;
      }

      await this.MarketData.create({
        sellVolume: latestSellOrder ? latestSellOrder.currentVolume : '',
        sellPrice: latestSellOrder ? latestSellOrder.limit : '',
        buyVolume: latestBuyOrder ? latestBuyOrder.currentVolume : '',
        buyPrice: latestBuyOrder ? latestBuyOrder.limit : '',
        matchVolume: latestVolume,
        matchPrice: latestPrice,
      });

      this.processing = false;
    } catch (err) {
      console.log(err);
    }
  }

  async matchNextOrder() {
    try {
      if (this.processing) {
        return;
      } else {
        this.processing = true;
      }
      const order = await this.Order.findOne({
        status: 'unprocessed',
      }).sort({
        created: 1,
      });
      if (!order) {
        this.processing = false;
        return;
      }
      await this.processOrder(order);
      this.matchNextOrder();
    } catch (err) {
      console.log(err);
      this.processing = false;
    }
  }

  async placeOrder(limit, volume, userId, isSelling = false) {
    try {
      const orderId = Mongoose.Types.ObjectId();
      const order = {
        _id: orderId,
        limit,
        originalVolume: volume,
        currentVolume: volume,
        userId,
        isSelling,
      };
      this.task.save(this.orderModelName, order);
      this.onBeforePlaceOrder(this.task, orderId, limit, volume, userId, isSelling);
      await this.task.run({ useMongoose: true });
      this.matchNextOrder();
    } catch (err) {
      console.log(err);
    }
  }

  async cancelOrder(orderId) {
    try {
      this.task.update(this.orderModelName, {
        _id: orderId,
      }, {
          status: 'canceled',
        })
      const order = await this.Order.findById(orderId);
      this.onCancelOrder(this.task, order);
      await this.task.run({ useMongoose: true });

    } catch (err) {
      console.log(err);
    }
  }

  async getOrdersByUserId(userId) {
    try {
      const orders = await this.Order.find({
        userId,
      }).lean();
      return orders;
    } catch (err) {
      console.log(err);
    }
  }

  async getLatestMarketData() {
    try {
      const latest = await this.MarketData.findOne()
        .sort({ created: -1 })
        .lean();

      return latest;
    } catch (err) {
      console.log(err);
    }
  }

  getOrderModel() {
    return this.Order;
  }

  getMarketDataModel() {
    return this.MarketData;
  }
}
