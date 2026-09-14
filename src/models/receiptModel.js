const { getDb } = require('../db');

const receiptModel = {
  // order_id 有 UNIQUE 约束：同一单重复回执在数据库层就被钉死
  insert(r) {
    const info = getDb().prepare(`
      INSERT INTO receipts (
        receipt_no, order_id, delivered_qty, empty_returned,
        new_deposit_qty, deposit_amount, cash_collected,
        order_building, actual_building, delivered_at, created_by, created_at, remark
      ) VALUES (
        @receiptNo, @orderId, @deliveredQty, @emptyReturned,
        @newDepositQty, @depositAmount, @cashCollected,
        @orderBuilding, @actualBuilding, @deliveredAt, @createdBy, @createdAt, @remark
      )
    `).run(r);
    return info.lastInsertRowid;
  },

  getByOrderId(orderId) {
    return getDb().prepare(`SELECT * FROM receipts WHERE order_id = ?`).get(orderId);
  },

  listByDate(date) {
    return getDb().prepare(`
      SELECT r.*, o.order_no, c.name AS customer_name, c.code AS customer_code,
             d.name AS driver_name
      FROM receipts r
      JOIN orders o ON o.id = r.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE date(r.delivered_at) = ?
      ORDER BY r.id
    `).all(date);
  },
};

module.exports = receiptModel;
