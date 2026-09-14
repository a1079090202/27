const { getDb } = require('../db');

const productModel = {
  list() {
    return getDb().prepare(`SELECT * FROM products WHERE active = 1 ORDER BY id`).all();
  },
  getById(id) {
    return getDb().prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  },
};

module.exports = productModel;
