const { getDb } = require('../db');
const depositModel = require('../models/depositModel');
const receiptModel = require('../models/receiptModel');

const reportService = {
  // 日结：三笔账 + 自动对账
  daily(date) {
    const db = getDb();

    // 第一笔：现金。收现来自回执（水款+押金），退押金是现金支出
    const cashRow = db.prepare(`
      SELECT COALESCE(SUM(cash_collected), 0) AS cash_in
      FROM receipts WHERE date(delivered_at) = ?
    `).get(date);
    const refundRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS cash_out
      FROM deposit_ledger
      WHERE direction='refund' AND date(occurred_at) = ?
    `).get(date);
    // 收现里水款 / 押金 拆开（与押金台账互验）
    const cashSplit = db.prepare(`
      SELECT
        COALESCE(SUM(r.cash_collected - r.deposit_amount), 0) AS cash_water,
        COALESCE(SUM(r.deposit_amount), 0) AS cash_deposit
      FROM receipts r WHERE date(r.delivered_at) = ?
    `).get(date);

    // 第二笔：未收款。今日送达产生的挂账，以及累计未收
    const todayUnpaid = db.prepare(`
      SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS amount,
             COUNT(*) AS orders
      FROM orders
      WHERE status='delivered' AND date(delivered_at) = ? AND total_amount > paid_amount
    `).get(date);
    const totalUnpaid = db.prepare(`
      SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS amount,
             COUNT(*) AS orders
      FROM orders
      WHERE status='delivered' AND total_amount > paid_amount
    `).get();

    // 第三笔：押金余额变动
    const movement = depositModel.dailyMovement(date);
    const ending = depositModel.totalBalanceUpTo(date);

    // 今日回执清单（现金明细）
    const receipts = receiptModel.listByDate(date);
    // 今日退款清单（现金支出明细）
    const refunds = db.prepare(`
      SELECT l.*, c.name AS customer_name, c.code AS customer_code
      FROM deposit_ledger l JOIN customers c ON c.id = l.customer_id
      WHERE l.direction='refund' AND date(l.occurred_at) = ?
      ORDER BY l.id
    `).all(date);

    // —— 自动对账钉死：三条线必须一致 ——
    // ① 今日押金净变动 = 台账逐行滚存的期末-期初
    const beginning = depositModel.totalBalanceUpTo(db
      .prepare(`SELECT date(?, '-1 day') AS d`).get(date).d);
    const netDelta = ending.amount - beginning.amount;
    const movementNet = movement.collected - movement.refunded;

    // ② 押金台账「按行求和净额」 == 「每客户最后余额求和」（全库，截止今天）
    const rawSigned = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction='collect' THEN amount ELSE -amount END), 0) AS amount,
             COALESCE(SUM(CASE WHEN direction='collect' THEN qty ELSE -qty END), 0) AS qty
      FROM deposit_ledger WHERE date(occurred_at) <= ?
    `).get(date);

    // 回执产生的押金收款（台账里 source_type='order' 的部分）
    const orderCollect = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM deposit_ledger
      WHERE direction='collect' AND source_type='order' AND date(occurred_at) = ?
    `).get(date);

    const checks = [
      {
        name: '今日押金净变动 = 期末-期初', unit: 'fen',
        pass: netDelta === movementNet,
        left: netDelta, right: movementNet,
      },
      {
        name: '台账逐行净额 = 客户滚存余额合计（金额）', unit: 'fen',
        pass: rawSigned.amount === ending.amount,
        left: rawSigned.amount, right: ending.amount,
      },
      {
        name: '台账逐行净额 = 客户滚存余额合计（桶数）', unit: 'qty',
        pass: rawSigned.qty === ending.qty,
        left: rawSigned.qty, right: ending.qty,
      },
      {
        name: '收现中的押金 = 押金台账今日回执收款', unit: 'fen',
        pass: cashSplit.cash_deposit === orderCollect.amount,
        left: cashSplit.cash_deposit, right: orderCollect.amount,
      },
    ];

    return {
      date,
      cash: {
        in: cashRow.cash_in,
        out: refundRow.cash_out,
        net: cashRow.cash_in - refundRow.cash_out,
        waterPart: cashSplit.cash_water,
        depositPart: cashSplit.cash_deposit,
      },
      unpaid: {
        todayAmount: todayUnpaid.amount,
        todayOrders: todayUnpaid.orders,
        totalAmount: totalUnpaid.amount,
        totalOrders: totalUnpaid.orders,
      },
      deposit: {
        collected: movement.collected,
        refunded: movement.refunded,
        net: movementNet,
        collectedQty: movement.collected_qty,
        refundedQty: movement.refunded_qty,
        beginAmount: beginning.amount,
        endAmount: ending.amount,
        endQty: ending.qty,
      },
      receipts,
      refunds,
      checks,
      allPass: checks.every((c) => c.pass),
    };
  },
};

module.exports = reportService;
