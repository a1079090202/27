const { getDb } = require('../db');
const depositModel = require('../models/depositModel');
const bucketModel = require('../models/bucketModel');
const receiptModel = require('../models/receiptModel');

const reportService = {
  // 日结：三笔账 + 空桶实物账 + 自动对账
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

    // 第二笔：未收款。今日送达产生的挂账，以及累计未收。
    // 部分付款按「押金优先冲抵」拆：欠押金 = MAX(押金-已收, 0)，欠水款 = 差额-欠押金。
    // 新押金足额闸门后，欠押金只可能是历史遗留，check 会把它钉出来。
    const unpaidSelect = (where) => `
      SELECT COALESCE(SUM(unpaid), 0) AS amount,
             COALESCE(SUM(deposit_unpaid), 0) AS deposit_part,
             COALESCE(SUM(unpaid - deposit_unpaid), 0) AS water_part,
             COUNT(*) AS orders FROM (
        SELECT (total_amount - paid_amount) AS unpaid,
               MAX(deposit_amount - paid_amount, 0) AS deposit_unpaid
        FROM orders
        WHERE status='delivered' AND total_amount > paid_amount${where ? ` AND ${where}` : ''}
      )
    `;
    // 今日新增按送达日；累计口径必须是「截至该日（含）」，与期末押金/空桶库存一致，
    // 否则后续日期新增挂账会让已封账日的重算结果发生假漂移。
    const todayUnpaid = db.prepare(unpaidSelect('date(delivered_at) = ?')).get(date);
    const totalUnpaid = db.prepare(unpaidSelect('date(delivered_at) <= ?')).get(date);

    // 第三笔：押金余额变动
    const movement = depositModel.dailyMovement(date);
    const ending = depositModel.totalBalanceUpTo(date);

    // 第四笔：空桶实物回收（两个通道）+ 账上余额抵扣置换
    const emptyMove = bucketModel.dailyMovement(date);
    const emptyStock = bucketModel.stockUpTo(date);
    const offsetToday = depositModel.totalOffsetOn(date);
    const anomalous = bucketModel.anomalousCustomersAsOf(date);

    // 押金令牌体检：收款批次不得被「直接退款 + 担保置换」超额支取；
    // 在保置换不得被经由其退出的退款超额支取。这是三重支取的事后侦探。
    const overalloc = depositModel.overallocations();
    const overCollects = overalloc.filter((r) => r.kind === 'collect');
    const overOffsets = overalloc.filter((r) => r.kind === 'offset');

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
    // ① 今日押金净变动 = 期末-期初（期末/期初均为业务时间口径，见 totalBalanceUpTo）
    const beginning = depositModel.totalBalanceUpTo(db
      .prepare(`SELECT date(?, '-1 day') AS d`).get(date).d);
    const netDelta = ending.amount - beginning.amount;
    const movementNet = movement.collected - movement.refunded;

    // ② 全库平衡式：逐行符号净额（全库，无日期过滤）== 各客户最新滚存行合计。
    //    这是检验「插入序滚存列」维护正确性的真不变式：每客户 id 最大行的滚存
    //    必然等于其全部历史符号和，与 occurred_at 无关，补录场景同样成立。
    //    （历史「截至某日」口径由 totalBalanceUpTo 按业务时间求和，不读滚存列。）
    const rawSigned = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction='collect' THEN amount ELSE -amount END), 0) AS amount,
             COALESCE(SUM(CASE WHEN direction='collect' THEN qty ELSE -qty END), 0) AS qty
      FROM deposit_ledger
    `).get();
    const storedCurrent = db.prepare(`
      SELECT COALESCE(SUM(balance_amount), 0) AS amount,
             COALESCE(SUM(balance_qty), 0) AS qty
      FROM (
        SELECT customer_id, balance_amount, balance_qty,
               ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY id DESC) rn
        FROM deposit_ledger
      ) WHERE rn = 1
    `).get();

    // 回执产生的押金收款（台账里 source_type='order' 的部分）
    const orderCollect = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM deposit_ledger
      WHERE direction='collect' AND source_type='order' AND date(occurred_at) = ?
    `).get(date);

    // 今日回执登记的收回空桶（与空桶实物台账 recover 通道互验）
    const receiptEmpty = db.prepare(`
      SELECT COALESCE(SUM(empty_returned), 0) AS qty
      FROM receipts WHERE date(delivered_at) = ?
    `).get(date);

    // 今日回执押金桶三段守恒：押金桶需求 = 账上抵扣 + 空桶抵扣 + 新收押金
    const conservation = db.prepare(`
      SELECT COALESCE(SUM(o.deposit_qty), 0) AS need,
             COALESCE(SUM(r.cover_balance_qty + r.empty_cover_qty + r.new_deposit_qty), 0) AS settled
      FROM receipts r JOIN orders o ON o.id = r.order_id
      WHERE date(r.delivered_at) = ?
    `).get(date);

    const checks = [
      {
        name: '今日押金净变动 = 期末-期初', unit: 'fen', scope: 'day',
        pass: netDelta === movementNet,
        left: netDelta, right: movementNet,
      },
      {
        name: '全库逐行净额 = 各客户当前滚存合计（金额）', unit: 'fen', scope: 'global',
        pass: rawSigned.amount === storedCurrent.amount,
        left: rawSigned.amount, right: storedCurrent.amount,
      },
      {
        name: '全库逐行净额 = 各客户当前滚存合计（桶数）', unit: 'qty', scope: 'global',
        pass: rawSigned.qty === storedCurrent.qty,
        left: rawSigned.qty, right: storedCurrent.qty,
      },
      {
        name: '收现中的押金 = 押金台账今日回执收款', unit: 'fen', scope: 'day',
        pass: cashSplit.cash_deposit === orderCollect.amount,
        left: cashSplit.cash_deposit, right: orderCollect.amount,
      },
      {
        name: '回执押金桶三段守恒：账上抵扣+空桶抵扣+新收 = 押金桶需求', unit: 'qty', scope: 'day',
        pass: conservation.need === conservation.settled,
        left: conservation.settled, right: conservation.need,
      },
      {
        name: '回执登记收回空桶 = 空桶实物台账（送达回收）', unit: 'qty', scope: 'day',
        pass: receiptEmpty.qty === emptyMove.recover,
        left: receiptEmpty.qty, right: emptyMove.recover,
      },
      {
        name: '退桶交回空桶 = 押金台账今日退款桶数', unit: 'qty', scope: 'day',
        pass: emptyMove.refund_in === movement.refunded_qty,
        left: emptyMove.refund_in, right: movement.refunded_qty,
      },
      {
        name: '截至当日账实异常客户为 0（累计交回空桶 ≤ 累计接收）', unit: 'qty', scope: 'day',
        pass: anomalous.length === 0,
        left: anomalous.length, right: 0,
      },
      {
        name: '收款批次无超额支取（直接退款 + 担保置换 ≤ 原桶数）', unit: 'qty', scope: 'global',
        pass: overCollects.length === 0,
        left: overCollects.length, right: 0,
      },
      {
        name: '在保担保置换无超额退出（经由置换的退款 ≤ 置换桶数）', unit: 'qty', scope: 'global',
        pass: overOffsets.length === 0,
        left: overOffsets.length, right: 0,
      },
      {
        name: '全库欠押金为 0（新押金必须足额，仅水款可挂账）', unit: 'fen', scope: 'global',
        pass: totalUnpaid.deposit_part === 0,
        left: totalUnpaid.deposit_part, right: 0,
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
        todayWater: todayUnpaid.water_part,
        todayDeposit: todayUnpaid.deposit_part,
        todayOrders: todayUnpaid.orders,
        totalAmount: totalUnpaid.amount,
        totalWater: totalUnpaid.water_part,
        totalDeposit: totalUnpaid.deposit_part,
        totalOrders: totalUnpaid.orders,
      },
      deposit: {
        collected: movement.collected,
        refunded: movement.refunded,
        net: movementNet,
        collectedQty: movement.collected_qty,
        refundedQty: movement.refunded_qty,
        beginAmount: beginning.amount,
        beginQty: beginning.qty,
        endAmount: ending.amount,
        endQty: ending.qty,
        // 账上押金桶抵扣置换（不退钱，但笔笔钉源头）
        offsetQty: offsetToday.qty,
        offsetLines: offsetToday.lines,
      },
      empty: {
        recover: emptyMove.recover,       // 回执当场收回
        refundIn: emptyMove.refund_in,    // 退桶交回
        todayTotal: emptyMove.total,
        stock: emptyStock,                // 全站在库空桶（累计回收）
      },
      anomalous,                          // 账实异常客户（有物无账：多报空桶）
      receipts,
      refunds,
      checks,
      allPass: checks.every((c) => c.pass),
    };
  },
};

module.exports = reportService;
