const { getDb } = require('../db');

// 日结封账快照数据访问层：只增不改（另有数据库触发器兜底）
const closeModel = {
  insert({ closeDate, reportJson, allPass, closedBy, closedAt }) {
    getDb().prepare(`
      INSERT INTO daily_close (close_date, report_json, all_pass, closed_by, closed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(closeDate, reportJson, allPass ? 1 : 0, closedBy, closedAt);
  },

  get(closeDate) {
    return getDb().prepare(`SELECT * FROM daily_close WHERE close_date = ?`).get(closeDate);
  },

  latest() {
    return getDb().prepare(`SELECT * FROM daily_close ORDER BY close_date DESC LIMIT 1`).get();
  },

  list({ limit = 400 } = {}) {
    return getDb().prepare(`
      SELECT * FROM daily_close ORDER BY close_date DESC LIMIT ?
    `).all(limit);
  },
};

module.exports = closeModel;
