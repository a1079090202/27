const { getDb } = require('../db');

// 空桶实物台账数据访问层：空桶只在两个通道回站（recover/refund_in），只增不改
const bucketModel = {
  insertMovement({
    customerId, movement, qty, sourceType, sourceId, orderId, refNo, occurredAt, createdBy, remark,
  }) {
    const info = getDb().prepare(`
      INSERT INTO empty_bucket_ledger (
        customer_id, movement, qty, source_type, source_id, order_id, ref_no,
        occurred_at, created_by, created_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customerId, movement, qty, sourceType, sourceId ?? null, orderId ?? null, refNo ?? null,
      occurredAt, createdBy, occurredAt, remark ?? null
    );
    return info.lastInsertRowid;
  },

  // 客户累计交回空桶（三个通道合计）
  totalReturned(customerId) {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(qty), 0) AS qty
      FROM empty_bucket_ledger WHERE customer_id = ?
    `).get(customerId);
    return row.qty;
  },

  // 客户累计出站桶数：2019 等历史补底押金桶 + 每张已送达回执实送桶数（押金桶+自有桶都算实物流出）
  totalOut(customerId) {
    const row = getDb().prepare(`
      SELECT
        (SELECT COALESCE(SUM(qty), 0) FROM deposit_ledger
          WHERE customer_id = ? AND direction = 'collect' AND source_type = 'migration')
        +
        (SELECT COALESCE(SUM(r.delivered_qty), 0)
           FROM receipts r JOIN orders o ON o.id = r.order_id
          WHERE o.customer_id = ?) AS qty
    `).get(customerId, customerId);
    return row.qty;
  },

  // 客户账实位置：出站 / 交回 / 尚在客户手中
  position(customerId) {
    const out = bucketModel.totalOut(customerId);
    const returned = bucketModel.totalReturned(customerId);
    return { out, returned, held: out - returned };
  },

  // 交回是否超过出站（账实脱钩：有物无账/多录空桶）。true = 异常，必须拦截
  wouldExceed(customerId, addQty) {
    return bucketModel.totalReturned(customerId) + addQty > bucketModel.totalOut(customerId);
  },

  // 全站空桶台账（空桶台账页），可按日期/客户过滤
  list({ date, customerId, limit = 500 } = {}) {
    const where = [];
    const params = {};
    if (date) { where.push(`date(e.occurred_at) = @date`); params.date = date; }
    if (customerId) { where.push(`e.customer_id = @customerId`); params.customerId = customerId; }
    const sql = `
      SELECT e.*, c.name AS customer_name, c.code AS customer_code,
             c.building, c.room
      FROM empty_bucket_ledger e JOIN customers c ON c.id = e.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.id DESC
      LIMIT @limit
    `;
    params.limit = limit;
    return getDb().prepare(sql).all(params);
  },

  // 某日空桶回收：分通道
  dailyMovement(date) {
    return getDb().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN movement='recover'   THEN qty ELSE 0 END), 0) AS recover,
        COALESCE(SUM(CASE WHEN movement='refund_in' THEN qty ELSE 0 END), 0) AS refund_in,
        COALESCE(SUM(qty), 0) AS total,
        COUNT(*) AS lines
      FROM empty_bucket_ledger WHERE date(occurred_at) = ?
    `).get(date);
  },

  // 截止某日（含）全站在库空桶滚存（空桶只回站，故为累计净额）
  stockUpTo(date) {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(qty), 0) AS qty
      FROM empty_bucket_ledger WHERE date(occurred_at) <= ?
    `).get(date);
    return row.qty;
  },

  // 账实异常客户：累计交回 > 累计出站。出站口径必须与写入闸门 totalOut 完全一致
  // （migration 历史补底押金桶 + 已送达回执实送桶数），否则补底客户会被漏报/误报。
  anomalousCustomers() {
    return bucketModel.anomalousCustomersAsOf(null);
  },

  // 截至某日（含）的账实异常客户；date=null 表示全库至今。
  // 出站 = migration 补底 + 该日前已送达回执实送；交回 = 该日前空桶台账累计。
  // 日结/封账必须用 asOf 口径，后续日期的业务才不会让已封账日产生假漂移。
  anomalousCustomersAsOf(date) {
    const dateCond = date ? 'AND date(r.delivered_at) <= ?' : '';
    const emptyCond = date ? 'AND date(occurred_at) <= ?' : '';
    const params = date ? [date, date] : [];
    return getDb().prepare(`
      SELECT * FROM (
        SELECT c.id, c.code, c.name, c.building, c.room,
          (SELECT COALESCE(SUM(qty), 0) FROM deposit_ledger
            WHERE customer_id = c.id AND direction = 'collect' AND source_type = 'migration')
          +
          (SELECT COALESCE(SUM(r.delivered_qty), 0)
             FROM receipts r JOIN orders o ON o.id = r.order_id
            WHERE o.customer_id = c.id ${dateCond}) AS out_qty,
          (SELECT COALESCE(SUM(qty), 0) FROM empty_bucket_ledger
            WHERE customer_id = c.id ${emptyCond}) AS returned_qty
        FROM customers c
        WHERE c.active = 1
      )
      WHERE returned_qty > out_qty
    `).all(...params);
  },
};

module.exports = bucketModel;
