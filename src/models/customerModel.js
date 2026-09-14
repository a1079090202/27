const { getDb } = require('../db');

function rowToCustomer(r) {
  return r ? { ...r, active: !!r.active } : null;
}

const customerModel = {
  create({ code, name, phone, building, room, createdBy }) {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO customers (code, name, phone, building, room, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, name, phone, building, room, createdBy || null);
    return customerModel.getById(info.lastInsertRowid);
  },

  getById(id) {
    return rowToCustomer(getDb().prepare(`SELECT * FROM customers WHERE id = ?`).get(id));
  },

  getByCode(code) {
    return rowToCustomer(getDb().prepare(`SELECT * FROM customers WHERE code = ?`).get(code));
  },

  // 报电话查单：精确优先
  findByPhone(phone) {
    const rows = getDb().prepare(`SELECT * FROM customers WHERE phone = ? AND active = 1`).all(phone);
    return rows.map(rowToCustomer);
  },

  search(keyword) {
    const kw = `%${keyword || ''}%`;
    return getDb().prepare(`
      SELECT * FROM customers
      WHERE active = 1 AND (name LIKE ? OR phone LIKE ? OR code LIKE ? OR building LIKE ?)
      ORDER BY code
    `).all(kw, kw, kw, kw).map(rowToCustomer);
  },

  list() {
    return getDb().prepare(`SELECT * FROM customers WHERE active = 1 ORDER BY code`).all().map(rowToCustomer);
  },
};

module.exports = customerModel;
