const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new Database(config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

// 幂等结构升级：schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给已存在的旧表补列。
// 每次启动按 table_info 检查，缺什么补什么；全新库这里全部已是 no-op。
function migrate(dbx) {
  const hasColumn = (table, col) =>
    dbx.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

  // 退款钉源记录加「经由哪笔担保置换退出」列（ALTER TABLE 无法补 FK 约束，
  // 引用完整性由 deposit_offset 触发器不可变 + service 层钉源保证；全新建库走 schema.sql 带 FK）。
  if (!hasColumn('deposit_refund_alloc', 'via_offset_id')) {
    dbx.exec(`ALTER TABLE deposit_refund_alloc ADD COLUMN via_offset_id INTEGER`);
  }
  dbx.exec(`
    CREATE INDEX IF NOT EXISTS idx_alloc_collect_via
      ON deposit_refund_alloc(collect_ledger_id, via_offset_id);
    CREATE INDEX IF NOT EXISTS idx_alloc_via_offset
      ON deposit_refund_alloc(via_offset_id);
  `);
}

function nowLocal() {
  // 与 SQLite datetime('now','localtime') 同口径
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayLocal() {
  return nowLocal().slice(0, 10);
}

module.exports = { getDb, nowLocal, todayLocal };
