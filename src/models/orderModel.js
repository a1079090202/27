const { getDb } = require('../db');

const orderModel = {
  insertHeader(o) {
    const info = getDb().prepare(`
      INSERT INTO orders (
        order_no, customer_id, order_date, total_qty, deposit_qty, own_qty,
        water_amount, deposit_amount, total_amount, paid_amount,
        status, remark, created_by, created_at
      ) VALUES (
        @orderNo, @customerId, @orderDate, @totalQty, @depositQty, @ownQty,
        @waterAmount, 0, @waterAmount, 0,
        'placed', @remark, @createdBy, @createdAt
      )
    `).run(o);
    return info.lastInsertRowid;
  },

  insertItem({ orderId, productId, bucketType, qty, unitPrice, depositPerBucket }) {
    getDb().prepare(`
      INSERT INTO order_items (order_id, product_id, bucket_type, qty, unit_price, deposit_per_bucket)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(orderId, productId, bucketType, qty, unitPrice, depositPerBucket);
  },

  // 回执结算后回写押金/应收/已收/状态（押金桶意向数量 deposit_qty 在开单时已定，不动）
  applyReceiptSettlement({
    orderId, depositAmount, paidAmount, deliveredAt,
  }) {
    getDb().prepare(`
      UPDATE orders SET
        deposit_amount = ?,
        total_amount = water_amount + ?,
        paid_amount = ?,
        status = 'delivered',
        delivered_at = ?
      WHERE id = ?
    `).run(depositAmount, depositAmount, paidAmount, deliveredAt, orderId);
  },

  markDispatched({ orderId, driverId, assignedBy, assignedAt }) {
    getDb().prepare(`
      UPDATE orders SET status = 'dispatched', driver_id = ?, assigned_by = ?, assigned_at = ?
      WHERE id = ? AND status = 'placed'
    `).run(driverId, assignedBy, assignedAt, orderId);
  },

  reassign({ orderId, driverId, assignedBy, assignedAt }) {
    getDb().prepare(`
      UPDATE orders SET driver_id = ?, assigned_by = ?, assigned_at = ?
      WHERE id = ? AND status = 'dispatched'
    `).run(driverId, assignedBy, assignedAt, orderId);
  },

  getById(id) {
    const db = getDb();
    const order = db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code,
             c.phone AS customer_phone, c.building AS customer_building, c.room AS customer_room,
             d.name AS driver_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.id = ?
    `).get(id);
    if (!order) return null;
    order.items = db.prepare(`
      SELECT i.*, p.name AS product_name
      FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ?
      ORDER BY i.id
    `).all(id);
    order.receipt = db.prepare(`SELECT * FROM receipts WHERE order_id = ?`).get(id);
    return order;
  },

  getByNo(orderNo) {
    const row = getDb().prepare(`SELECT id FROM orders WHERE order_no = ?`).get(orderNo);
    return row ? orderModel.getById(row.id) : null;
  },

  list({ status, date, driverId, customerId, overdue = false } = {}) {
    const where = [];
    const p = {};
    if (status) { where.push(`o.status = @status`); p.status = status; }
    if (date) { where.push(`o.order_date = @date`); p.date = date; }
    if (driverId) { where.push(`o.driver_id = @driverId`); p.driverId = driverId; }
    if (customerId) { where.push(`o.customer_id = @customerId`); p.customerId = customerId; }
    // 超过 24 小时仍未录回执（未送达、未取消）
    if (overdue) {
      where.push(`o.status IN ('placed','dispatched')`);
      where.push(`(
        CASE WHEN o.assigned_at IS NOT NULL THEN o.assigned_at ELSE o.created_at END
      ) <= datetime('now','localtime','-24 hours')`);
    }
    return getDb().prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code,
             c.building AS customer_building, c.room AS customer_room,
             c.phone AS customer_phone, d.name AS driver_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC
    `).all(p);
  },

  // 客户历史订单（报电话查单用）
  listByCustomer(customerId) {
    return getDb().prepare(`
      SELECT o.*, d.name AS driver_name
      FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.customer_id = ? AND o.status != 'cancelled'
      ORDER BY o.id DESC
    `).all(customerId);
  },

  // 客户累计桶数
  customerTotals(customerId) {
    return getDb().prepare(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(CASE WHEN status='delivered' THEN total_qty END),0) AS delivered_qty,
        COALESCE(SUM(CASE WHEN status='delivered' THEN deposit_qty END),0) AS deposit_qty,
        COALESCE(SUM(CASE WHEN status='delivered' THEN own_qty END),0) AS own_qty
      FROM orders WHERE customer_id = ?
    `).get(customerId);
  },

  nextOrderNo(date) {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM orders WHERE order_date = ?
    `).get(date);
    return `${date.replace(/-/g, '')}-${String(row.n + 1).padStart(3, '0')}`;
  },
};

module.exports = orderModel;
