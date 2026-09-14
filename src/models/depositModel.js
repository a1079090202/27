const { getDb } = require('../db');

// 押金台账数据访问层：只做裸 SQL，事务由 depositService 编排
const depositModel = {
  // 客户当前押金余额：取台账最后一行（balance 是逐行滚存的）
  getBalance(customerId) {
    const row = getDb().prepare(`
      SELECT balance_qty AS qty, balance_amount AS amount
      FROM deposit_ledger
      WHERE customer_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(customerId);
    return row || { qty: 0, amount: 0 };
  },

  insertEntry({
    customerId, direction, qty, unitAmount, amount,
    sourceType, sourceId, orderId, refNo, occurredAt, createdBy, remark,
  }) {
    const db = getDb();
    const bal = depositModel.getBalance(customerId);
    const signed = direction === 'collect' ? 1 : -1;
    const balanceQty = bal.qty + signed * qty;
    const balanceAmount = bal.amount + signed * amount;
    const info = db.prepare(`
      INSERT INTO deposit_ledger (
        customer_id, direction, qty, unit_amount, amount,
        balance_qty, balance_amount,
        source_type, source_id, order_id, ref_no, occurred_at, created_by, created_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customerId, direction, qty, unitAmount, amount,
      balanceQty, balanceAmount,
      sourceType, sourceId ?? null, orderId ?? null, refNo ?? null,
      occurredAt, createdBy, occurredAt, remark ?? null
    );
    return info.lastInsertRowid;
  },

  insertAllocation(refundLedgerId, collectLedgerId, qty) {
    getDb().prepare(`
      INSERT INTO deposit_refund_alloc (refund_ledger_id, collect_ledger_id, qty)
      VALUES (?, ?, ?)
    `).run(refundLedgerId, collectLedgerId, qty);
  },

  // 客户尚未退完的收款批次（FIFO 队列），按收款先后
  openCollects(customerId) {
    return getDb().prepare(`
      SELECT * FROM (
        SELECT l.*,
          l.qty - COALESCE((
            SELECT SUM(a.qty) FROM deposit_refund_alloc a WHERE a.collect_ledger_id = l.id
          ), 0) AS remain_qty
        FROM deposit_ledger l
        WHERE l.customer_id = ? AND l.direction = 'collect'
      ) WHERE remain_qty > 0
      ORDER BY id
    `).all(customerId);
  },

  listByCustomer(customerId) {
    return getDb().prepare(`
      SELECT l.*, c.name AS customer_name, c.code AS customer_code
      FROM deposit_ledger l JOIN customers c ON c.id = l.customer_id
      WHERE l.customer_id = ?
      ORDER BY l.id
    `).all(customerId);
  },

  // 全量台账（押金台账页），可按日期/客户过滤
  list({ date, customerId, limit = 500 } = {}) {
    const where = [];
    const params = {};
    if (date) { where.push(`date(l.occurred_at) = @date`); params.date = date; }
    if (customerId) { where.push(`l.customer_id = @customerId`); params.customerId = customerId; }
    const sql = `
      SELECT l.*, c.name AS customer_name, c.code AS customer_code,
             c.building, c.room
      FROM deposit_ledger l JOIN customers c ON c.id = l.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.id DESC
      LIMIT @limit
    `;
    params.limit = limit;
    return getDb().prepare(sql).all(params);
  },

  // 一笔退款对应的收款来源（钉到每张原始收据）
  allocationsOf(refundLedgerId) {
    return getDb().prepare(`
      SELECT a.qty, l.ref_no AS collect_ref_no, l.occurred_at AS collect_at,
             l.unit_amount, l.id AS collect_ledger_id, l.source_type
      FROM deposit_refund_alloc a
      JOIN deposit_ledger l ON l.id = a.collect_ledger_id
      WHERE a.refund_ledger_id = ?
      ORDER BY l.id
    `).all(refundLedgerId);
  },

  // 某日押金变动：收、退、净变动（分）
  dailyMovement(date) {
    return getDb().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction='collect' THEN amount ELSE 0 END), 0) AS collected,
        COALESCE(SUM(CASE WHEN direction='refund'  THEN amount ELSE 0 END), 0) AS refunded,
        COALESCE(SUM(CASE WHEN direction='collect' THEN qty ELSE 0 END), 0) AS collected_qty,
        COALESCE(SUM(CASE WHEN direction='refund'  THEN qty ELSE 0 END), 0) AS refunded_qty,
        COUNT(*) AS lines
      FROM deposit_ledger
      WHERE date(occurred_at) = ?
    `).get(date);
  },

  // 截止某日（含）的押金总余额——与逐行滚存余额合计互验
  totalBalanceUpTo(date) {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(balance_amount), 0) AS amount,
             COALESCE(SUM(balance_qty), 0) AS qty
      FROM (
        SELECT customer_id, balance_amount, balance_qty,
               ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY id DESC) rn
        FROM deposit_ledger
        WHERE date(occurred_at) <= ?
      ) WHERE rn = 1
    `).get(date);
    return { amount: row.amount, qty: row.qty };
  },
};

module.exports = depositModel;
