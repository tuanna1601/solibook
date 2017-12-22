'use strict';

import BigNumber from 'bignumber.js';
import Co from 'co';
import Fawn from 'fawn';
import Mongoose from 'mongoose';

export default class OrderMatching {
  constructor(mongoose, onAfterMatched, getMarketData) {

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
    this.Order = mongoose.model('Order', order);

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

    this.MarketData = mongoose.model('MarketData', marketData);

    Fawn.init(mongoose);
    this.task = Fawn.Task();
    this.onAfterMatched = onAfterMatched;
    this.matchNextOrder();
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
          .update('Order', {
            _id: order._id,
          }, {
            currentVolume: BigNumber(order.currentVolume).minus(volume),
          })
          .update('Order', {
            _id: matching._id,
          }, {
            currentVolume: BigNumber(matching.currentVolume).minus(volume),
          });
        this.onAfterMatched(this.task, order._id, matching._id, volume.valueOf(), price);
        await this.task.run({ useMongoose: true })
          .then((results) => {
            if (results[0].nModified = 1) {
              order.currentVolume = BigNumber(order.currentVolume).minus(volume);
            }
          });
      }

      // set processed
      await this.task
        .update('Order', {
          _id: order._id,
        }, {
          status: 'processed',
        }).run({ useMongoose: true });

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

      if (!latestVolume && !matchPrice && latestMarketData) {
        latestVolume = latestMarketData.matchVolume,
          latestPrice = latestMarketData.matchPrice;
      }

      await this.task.save('MarketData', {
        sellVolume: latestSellOrder ? latestSellOrder.currentVolume : '',
        sellPrice: latestSellOrder ? latestSellOrder.limit : '',
        buyVolume: latestBuyOrder ? latestBuyOrder.currentVolume : '',
        buyPrice: latestBuyOrder ? latestBuyOrder.limit : '',
        matchVolume: latestVolume,
        matchPrice: latestPrice,
      }).run({ useMongoose: true });
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
      await this.matchNextOrder();
    } catch (err) {
      console.log(err);
      this.processing = false;
    }
  }

  async placeOrder(limit, volume, userId, isSelling = false) {
    try {
      const order = {
        limit,
        originalVolume: volume,
        currentVolume: volume,
        userId,
        isSelling,
      };
      await this.task.save('Order', order).run({ useMongoose: true });
      await this.matchNextOrder();
    } catch (err) {
      console.log(err);
    }
  }

  async cancelOrder(orderId) {
    try {
      await this.task.update('Order', {
        _id: orderId,
      }, {
          status: 'canceled',
        }).run({ useMongoose: true });

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
}
