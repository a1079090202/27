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

  insertAllocation(refundLedgerId, collectLedgerId, qty, viaOffsetId = null) {
    getDb().prepare(`
      INSERT INTO deposit_refund_alloc (refund_ledger_id, collect_ledger_id, via_offset_id, qty)
      VALUES (?, ?, ?, ?)
    `).run(refundLedgerId, collectLedgerId, viaOffsetId, qty);
  },

  // —— 押金抵扣（担保置换）台账：只增不改，FIFO 钉到历史收款批次 ——
  insertOffset({ customerId, receiptId, orderId, qty, occurredAt, createdBy, remark }) {
    const info = getDb().prepare(`
      INSERT INTO deposit_offset (
        customer_id, receipt_id, order_id, qty, occurred_at, created_by, created_at, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(customerId, receiptId, orderId, qty, occurredAt, createdBy, occurredAt, remark ?? null);
    return info.lastInsertRowid;
  },

  insertOffsetAlloc(offsetId, collectLedgerId, qty) {
    getDb().prepare(`
      INSERT INTO deposit_offset_alloc (offset_id, collect_ledger_id, qty)
      VALUES (?, ?, ?)
    `).run(offsetId, collectLedgerId, qty);
  },

  // 某张回执的抵扣头（一般一行）
  offsetsByReceipt(receiptId) {
    return getDb().prepare(`
      SELECT * FROM deposit_offset WHERE receipt_id = ? ORDER BY id
    `).all(receiptId);
  },

  // 一次抵扣钉到的历史收款批次（与退款 allocationsOf 对称）
  offsetAllocationsOf(offsetId) {
    return getDb().prepare(`
      SELECT a.qty, l.ref_no AS collect_ref_no, l.occurred_at AS collect_at,
             l.unit_amount, l.id AS collect_ledger_id, l.source_type
      FROM deposit_offset_alloc a
      JOIN deposit_ledger l ON l.id = a.collect_ledger_id
      WHERE a.offset_id = ?
      ORDER BY l.id
    `).all(offsetId);
  },

  // 回执抵扣的完整溯源（头 + 每笔来源）
  offsetTraceByReceipt(receiptId) {
    return depositModel.offsetsByReceipt(receiptId).map((o) => ({
      ...o,
      allocations: depositModel.offsetAllocationsOf(o.id),
    }));
  },

  // 客户全部抵扣记录（客户详情页用）
  offsetsByCustomer(customerId) {
    return getDb().prepare(`
      SELECT * FROM deposit_offset WHERE customer_id = ? ORDER BY id
    `).all(customerId);
  },

  // 客户全部抵扣记录 + 每条钉到的历史收款（客户详情页溯源）
  offsetTraceByCustomer(customerId) {
    return depositModel.offsetsByCustomer(customerId).map((o) => ({
      ...o,
      allocations: depositModel.offsetAllocationsOf(o.id),
    }));
  },

  // 某日抵扣桶数合计
  totalOffsetOn(date) {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(qty), 0) AS qty, COUNT(*) AS lines
      FROM deposit_offset WHERE date(occurred_at) = ?
    `).get(date);
    return row;
  },

  // 担保置换（cover_balance）候选池：每个收款批次里「未被直接退款、也未被置换占用」的余量。
  // 这是每个桶只能走一次的「直接池」——经由置换退出的桶（via_offset_id 非空）不回到本池，
  // 否则同一笔押金能被担保置换多次（三重支取）。
  openDirectPools(customerId) {
    return getDb().prepare(`
      SELECT * FROM (
        SELECT l.*,
          l.qty
          - COALESCE((
              SELECT SUM(a.qty) FROM deposit_refund_alloc a
              WHERE a.collect_ledger_id = l.id AND a.via_offset_id IS NULL
            ), 0)
          - COALESCE((
              SELECT SUM(a.qty) FROM deposit_offset_alloc a
              WHERE a.collect_ledger_id = l.id
            ), 0) AS remain_qty
        FROM deposit_ledger l
        WHERE l.customer_id = ? AND l.direction = 'collect'
      ) WHERE remain_qty > 0
      ORDER BY id
    `).all(customerId);
  },

  // 直接池可用总量（回执能拿多少账上余额做担保置换）
  totalDirectPool(customerId) {
    return depositModel.openDirectPools(customerId)
      .reduce((s, b) => s + b.remain_qty, 0);
  },

  // 退款 FIFO 队列：按「根收款批次 id」单一顺序归并，根内先退直接池余量，
  // 再退钉在该根上、尚未经置换退出的在保桶（按 offset id 序）。
  // 不能分「先全部直接池、再全部置换」两个全局阶段——旧根的在保桶必须先于新根的直接桶退出，
  // 否则跨押金标准时退款金额会算错。
  // 每行：{ collect_id, unit_amount, via_offset_id, leg_order, ord_id, qty }
  refundQueue(customerId) {
    return getDb().prepare(`
      SELECT l.id AS collect_id, l.unit_amount, NULL AS via_offset_id,
             1 AS leg_order, l.id AS ord_id,
        l.qty
        - COALESCE((SELECT SUM(a.qty) FROM deposit_refund_alloc a
                     WHERE a.collect_ledger_id = l.id AND a.via_offset_id IS NULL), 0)
        - COALESCE((SELECT SUM(a.qty) FROM deposit_offset_alloc a
                     WHERE a.collect_ledger_id = l.id), 0) AS qty
      FROM deposit_ledger l
      WHERE l.customer_id = ? AND l.direction = 'collect'
      UNION ALL
      SELECT oa.collect_ledger_id AS collect_id, l.unit_amount, oa.offset_id AS via_offset_id,
             2 AS leg_order, oa.offset_id AS ord_id,
        oa.qty - COALESCE((SELECT SUM(ra.qty) FROM deposit_refund_alloc ra
                            WHERE ra.via_offset_id = oa.offset_id
                              AND ra.collect_ledger_id = oa.collect_ledger_id), 0) AS qty
      FROM deposit_offset_alloc oa
      JOIN deposit_offset o ON o.id = oa.offset_id
      JOIN deposit_ledger l ON l.id = oa.collect_ledger_id
      WHERE o.customer_id = ?
      ORDER BY collect_id, leg_order, ord_id
    `).all(customerId, customerId).filter((r) => r.qty > 0);
  },

  // 全库超额支取体检（写事务内即时硬闸 + 日结事后侦探共用）：
  // ① 每个收款批次：直接退款 + 担保置换占用 ≤ 原桶数
  // ② 每笔担保置换：经由其退出的退款 ≤ 置换桶数
  overallocations() {
    return getDb().prepare(`
      SELECT * FROM (
        SELECT l.id AS kind_ref_id, 'collect' AS kind, l.customer_id, l.ref_no,
               l.qty,
          COALESCE((SELECT SUM(a.qty) FROM deposit_refund_alloc a
                     WHERE a.collect_ledger_id = l.id AND a.via_offset_id IS NULL), 0)
          + COALESCE((SELECT SUM(a.qty) FROM deposit_offset_alloc a
                       WHERE a.collect_ledger_id = l.id), 0) AS used
        FROM deposit_ledger l
        WHERE l.direction = 'collect'
        UNION ALL
        SELECT o.id AS kind_ref_id, 'offset' AS kind, o.customer_id, NULL AS ref_no,
               o.qty,
          (SELECT COALESCE(SUM(ra.qty), 0) FROM deposit_refund_alloc ra
            WHERE ra.via_offset_id = o.id) AS used
        FROM deposit_offset o
      )
      WHERE used > qty
    `).all();
  },

  // 某客户的桶/金额余额是否仍能覆盖其全部在保押金（置换不动余额，理论恒成立，防御性校验）
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

  // 一笔退款对应的收款来源（钉到每张原始收据；via_offset_id 非空表示该桶是经担保置换退出的在保桶）
  allocationsOf(refundLedgerId) {
    return getDb().prepare(`
      SELECT a.qty, a.via_offset_id, l.ref_no AS collect_ref_no, l.occurred_at AS collect_at,
             l.unit_amount, l.id AS collect_ledger_id, l.source_type,
             rc.receipt_no AS via_receipt_no, fo.occurred_at AS via_at
      FROM deposit_refund_alloc a
      JOIN deposit_ledger l ON l.id = a.collect_ledger_id
      LEFT JOIN deposit_offset fo ON fo.id = a.via_offset_id
      LEFT JOIN receipts rc ON rc.id = fo.receipt_id
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

  // 截止某日（含）的押金总余额——历史报表口径：按业务时间 occurred_at 的逐行符号求和。
  // 故意不读行内滚存列（balance_*）：滚存列按插入序维护，只服务「当前余额」(getBalance)。
  // 补录（2019 老收据/补登回执/补登退桶）occurred_at 在过去、id 却在最前，
  // 按插入序截取会把「报表日期之后才发生的业务」泄漏进历史期末余额。
  // 符号求和是纯函数：补录自动重述其业务日期之后的所有历史期末，这正是业务真相。
  totalBalanceUpTo(date) {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction='collect' THEN amount ELSE -amount END), 0) AS amount,
             COALESCE(SUM(CASE WHEN direction='collect' THEN qty ELSE -qty END), 0) AS qty
      FROM deposit_ledger
      WHERE date(occurred_at) <= ?
    `).get(date);
    return { amount: row.amount, qty: row.qty };
  },
};

module.exports = depositModel;
