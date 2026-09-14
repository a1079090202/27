const { getDb } = require('../db');

const driverModel = {
  list(activeOnly = true) {
    const sql = `SELECT * FROM drivers ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY code`;
    return getDb().prepare(sql).all();
  },
  getById(id) {
    return getDb().prepare(`SELECT * FROM drivers WHERE id = ?`).get(id);
  },
};

module.exports = driverModel;
