const { getDb, nowLocal, todayLocal } = require('../db');
const orderModel = require('../models/orderModel');
const receiptModel = require('../models/receiptModel');
const customerModel = require('../models/customerModel');
const driverModel = require('../models/driverModel');
const productModel = require('../models/productModel');
const bucketModel = require('../models/bucketModel');
const depositModel = require('../models/depositModel');
const depositService = require('./depositService');
const { logAction } = require('../models/logModel');
const { BusinessError, DuplicateReceiptError, NotFoundError } = require('./errors');
const { fenToYuan } = require('../utils/money');
const closeService = require('./closeService');

const orderService = {
  /**
   * 开单：品牌、数量；bucket_type=deposit 用押金桶 / own 客户自有桶，分开记。
   * items: [{ productId, bucketType: 'deposit'|'own', qty }]
   * 押金在送达回执时按「客户已有押金桶 + 当场交回空桶」据实结算，开单时不收。
   */
  createOrder({ customerId, items, remark, operator, orderDate }) {
    if (!operator) throw new BusinessError('缺少操作人');
    orderDate = orderDate || todayLocal();

    const customer = customerModel.getById(customerId);
    if (!customer || !customer.active) throw new BusinessError('客户不存在或已停用');

    if (!Array.isArray(items) || items.length === 0) throw new BusinessError('至少一行明细');

    const lines = [];
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw new BusinessError('数量必须是正整数');
      if (!['deposit', 'own'].includes(it.bucketType)) throw new BusinessError('桶类型只能是 deposit/own');
      const product = productModel.getById(it.productId);
      if (!product || !product.active) throw new BusinessError('水种/品牌不存在');
      lines.push({ product, bucketType: it.bucketType, qty });
    }

    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const depositQty = lines.filter((l) => l.bucketType === 'deposit').reduce((s, l) => s + l.qty, 0);
    const ownQty = totalQty - depositQty;
    const waterAmount = lines.reduce((s, l) => s + l.qty * l.product.unit_price, 0);

    const db = getDb();
    return db.transaction(() => {
      const orderNo = orderModel.nextOrderNo(orderDate);
      const createdAt = nowLocal();
      const orderId = orderModel.insertHeader({
        orderNo,
        customerId,
        orderDate,
        totalQty,
        depositQty,
        ownQty,
        waterAmount,
        remark: remark || null,
        createdBy: operator,
        createdAt,
      });
      for (const l of lines) {
        orderModel.insertItem({
          orderId,
          productId: l.product.id,
          bucketType: l.bucketType,
          qty: l.qty,
          unitPrice: l.product.unit_price,
          depositPerBucket: l.product.deposit_per_bucket,
        });
      }
      logAction({
        action: 'create_order',
        entityType: 'order',
        entityId: orderId,
        refNo: orderNo,
        operator,
        detail: { totalQty, depositQty, ownQty, waterAmount },
      });
      return orderModel.getById(orderId);
    })();
  },

  // 分派给师傅；必须先有单（placed）。改派走 reassign
  dispatch({ orderId, driverId, operator }) {
    if (!operator) throw new BusinessError('缺少操作人');
    const order = orderModel.getById(orderId);
    if (!order) throw new NotFoundError('订单不存在');
    const driver = driverModel.getById(driverId);
    if (!driver || !driver.active) throw new BusinessError('师傅不存在或已停用');
    if (order.status !== 'placed') throw new BusinessError(`当前状态 ${order.status}，不能分派`);

    const assignedAt = nowLocal();
    getDb().transaction(() => {
      orderModel.markDispatched({ orderId, driverId, assignedBy: operator, assignedAt });
      logAction({
        action: 'dispatch_order',
        entityType: 'order',
        entityId: orderId,
        refNo: order.order_no,
        operator,
        detail: { driverId, driverName: driver.name },
      });
    })();
    return orderModel.getById(orderId);
  },

  // 已分派的单改派给别的师傅（留痕）
  reassign({ orderId, driverId, operator }) {
    const order = orderModel.getById(orderId);
    if (!order) throw new NotFoundError('订单不存在');
    if (order.status !== 'dispatched') throw new BusinessError('只有已分派未送达的单能改派');
    const driver = driverModel.getById(driverId);
    if (!driver || !driver.active) throw new BusinessError('师傅不存在');
    const assignedAt = nowLocal();
    getDb().transaction(() => {
      orderModel.reassign({ orderId, driverId, assignedBy: operator, assignedAt });
      logAction({
        action: 'reassign_order',
        entityType: 'order',
        entityId: orderId,
        refNo: order.order_no,
        operator,
        detail: { fromDriverId: order.driver_id, toDriverId: driverId },
      });
    })();
    return orderModel.getById(orderId);
  },

  /**
   * 送达回执（幂等）。
   * 同一订单第二次提交：在写任何数据之前发现已有回执 → DuplicateReceiptError，
   * 订单数、押金台账、现金一分都不动。数据库 receipts.order_id UNIQUE 是第二道闸。
   *
   * 押金结算：本单「押金桶」先用 ① 客户账上已有押金桶 ② 本次收回的空桶 抵扣，
   * 抵扣不完的才是新押金桶，收押金并进押金台账。
   */
  createReceipt({ orderId, emptyReturned, cashCollected, actualBuilding, operator, remark, deliveredAt }) {
    if (!operator) throw new BusinessError('缺少操作人（录回执的师傅/操作员）');
    deliveredAt = deliveredAt || nowLocal();
    emptyReturned = Number(emptyReturned) || 0;
    if (!Number.isInteger(emptyReturned) || emptyReturned < 0) throw new BusinessError('收回空桶数不正确');

    const db = getDb();
    return db.transaction(() => {
      const order = orderModel.getById(orderId);
      if (!order) throw new NotFoundError('订单不存在');

      // —— 封账时间闸：回执业务日期不得落入已封账区间 ——
      closeService.assertBusinessDateOpen(deliveredAt.slice(0, 10), '回执');

      // —— 幂等闸门：任何写入之前先查 ——
      const existing = receiptModel.getByOrderId(orderId);
      if (existing || order.status === 'delivered') {
        throw new DuplicateReceiptError(existing);
      }
      if (order.status !== 'dispatched') throw new BusinessError(`订单状态 ${order.status}，请先分派再录回执`);

      const depositLines = order.items
        .filter((i) => i.bucket_type === 'deposit')
        .map((i) => ({ unitAmount: i.deposit_per_bucket, qty: i.qty }));
      const totalDepositQty = depositLines.reduce((s, l) => s + l.qty, 0);

      // 押金桶去向三段：① 账上已有押金桶的「可置换直接池」（担保置换）② 当场交回空桶 ③ 剩余才收新押金。
      // 不能用押金净余额：经置换在保的桶仍在净余额里，但直接池已用完，再置换就是同一笔押金重复支取。
      const preBalance = depositService.getBalance(order.customer_id);
      const directPool = depositModel.totalDirectPool(order.customer_id);
      const coverBalanceQty = Math.min(totalDepositQty, directPool);
      const coverEmptyQty = Math.min(totalDepositQty - coverBalanceQty, emptyReturned);
      const newDepositQty = totalDepositQty - coverBalanceQty - coverEmptyQty;
      const surplusEmpty = emptyReturned - coverEmptyQty; // 多交回、不涉及押金的空桶

      // 新押金按明细行分摊（账上/空桶抵扣先消耗前序行，剩余行才收新押金）
      let leftCover = coverBalanceQty + coverEmptyQty;
      const newDepositLines = [];
      for (const ln of depositLines) {
        const cover = Math.min(ln.qty, leftCover);
        leftCover -= cover;
        const nq = ln.qty - cover;
        if (nq > 0) newDepositLines.push({ qty: nq, unitAmount: ln.unitAmount });
      }
      const depositAmount = newDepositLines.reduce((s, l) => s + l.qty * l.unitAmount, 0);

      // —— 账实硬约束：本回执后累计实物交回不得超过累计接收（历史补底押金桶也算接收）——
      const priorOut = bucketModel.totalOut(order.customer_id);
      const priorReturned = bucketModel.totalReturned(order.customer_id);
      const projectOut = priorOut + order.total_qty;
      const projectReturned = priorReturned + emptyReturned;
      if (projectReturned > projectOut) {
        throw new BusinessError(
          `空桶账实不符：本回执后累计交回 ${projectReturned} 个，超过该客户累计接收 ` +
          `${projectOut} 个（历史已交回 ${priorReturned}），请核对「收回空桶数」`
        );
      }

      const totalDue = order.water_amount + depositAmount;
      if (cashCollected === undefined || cashCollected === null || cashCollected === '') {
        cashCollected = totalDue; // 默认货到款清
      }
      cashCollected = Number(cashCollected);
      if (!Number.isInteger(cashCollected) || cashCollected < 0) throw new BusinessError('现金金额不正确');
      if (cashCollected > totalDue) throw new BusinessError(`收款 ${cashCollected} 分超过应收 ${totalDue} 分`);
      // 新押金必须足额：押金是桶的担保，欠押金 = 无担保的桶在客户手里；水款允许挂账。
      if (cashCollected < depositAmount) {
        throw new BusinessError(
          `押金必须足额：本次新收押金 ¥${fenToYuan(depositAmount)}，` +
          `实收现金至少要覆盖押金（水款不足可挂账，押金不可欠）`
        );
      }

      const building = actualBuilding && actualBuilding.trim() ? actualBuilding.trim() : order.customer_building;
      const receiptNo = `R${deliveredAt.slice(0, 10).replace(/-/g, '')}-${String(
        receiptModel.listByDate(deliveredAt.slice(0, 10)).length + 1
      ).padStart(3, '0')}`;

      const receiptId = receiptModel.insert({
        receiptNo,
        orderId,
        deliveredQty: order.total_qty,
        emptyReturned,
        coverBalanceQty,
        emptyCoverQty: coverEmptyQty,
        newDepositQty,
        depositAmount,
        cashCollected,
        orderBuilding: order.customer_building,
        actualBuilding: building,
        deliveredAt,
        createdBy: operator,
        createdAt: deliveredAt,
        remark: remark || null,
      });

      // ① 账上押金桶抵扣：FIFO 钉到历史收款批次 + 旧桶视同交回（deposit_offset + 空桶台账）
      let offsetResult = null;
      if (coverBalanceQty > 0) {
        offsetResult = depositService.applyOffset({
          customerId: order.customer_id,
          qty: coverBalanceQty,
          orderId,
          receiptId,
          receiptNo,
          operator,
          occurredAt: deliveredAt,
        });
      }

      // ② 当场收回的实物空桶入空桶台账（含用于抵扣的与多交回的）
      if (emptyReturned > 0) {
        bucketModel.insertMovement({
          customerId: order.customer_id,
          movement: 'recover',
          qty: emptyReturned,
          sourceType: 'receipt',
          sourceId: receiptId,
          orderId,
          refNo: receiptNo,
          occurredAt: deliveredAt,
          createdBy: operator,
          remark: surplusEmpty > 0 ? `送达收回空桶（其中 ${surplusEmpty} 个不抵扣押金）` : '送达收回空桶',
        });
      }

      // ③ 真正的新押金桶才收押金、进押金台账（与回执同一事务）
      let ledgerIds = [];
      if (newDepositLines.length) {
        ledgerIds = depositService.collectOnReceipt({
          customerId: order.customer_id,
          lines: newDepositLines,
          orderId,
          receiptId,
          receiptNo,
          operator,
          occurredAt: deliveredAt,
        }).ledgerIds;
      }

      orderModel.applyReceiptSettlement({
        orderId,
        depositAmount,
        paidAmount: cashCollected,
        deliveredAt,
      });

      logAction({
        action: 'create_receipt',
        entityType: 'order',
        entityId: orderId,
        refNo: receiptNo,
        operator,
        detail: {
          deliveredQty: order.total_qty, emptyReturned,
          coverBalanceQty, coverEmptyQty, newDepositQty,
          depositAmount, cashCollected, priorBalanceQty: preBalance.qty,
          surplusEmpty, wrongBuilding: building !== order.customer_building,
          actualBuilding: building, ledgerIds,
          offsetId: offsetResult ? offsetResult.offsetId : null,
          offsetAllocations: offsetResult ? offsetResult.allocations : [],
        },
      });

      return {
        order: orderModel.getById(orderId),
        receipt: receiptModel.getByOrderId(orderId),
        settlement: {
          priorBalanceQty: preBalance.qty,
          emptyReturned,
          coverBalanceQty,
          coverEmptyQty,
          surplusEmpty,
          coveredQty: coverBalanceQty + coverEmptyQty,
          newDepositQty,
          depositAmount,
          waterAmount: order.water_amount,
          totalDue,
          cashCollected,
          unpaid: totalDue - cashCollected,
          wrongBuilding: building !== order.customer_building,
          offsetAllocations: offsetResult ? offsetResult.allocations : [],
        },
      };
    })();
  },

  getById: orderModel.getById,
  getByNo: orderModel.getByNo,
  list: orderModel.list,
};

module.exports = orderService;
