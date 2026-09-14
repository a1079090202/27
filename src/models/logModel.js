const { getDb } = require('../db');

function logAction({ action, entityType, entityId, refNo, operator, detail }) {
  getDb().prepare(`
    INSERT INTO action_log (action, entity_type, entity_id, ref_no, operator, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  `).run(action, entityType || null, entityId || null, refNo || null, operator,
        detail ? JSON.stringify(detail) : null);
}

module.exports = { logAction };
