-- 水站配送与空桶押金台账
-- 金额全部以「分」存储；时间为本地时间 TEXT: YYYY-MM-DD HH:MM:SS

PRAGMA foreign_keys = ON;

-- 客户档案：楼栋 + 水牌号 + 电话
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,          -- 水牌号
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  building   TEXT NOT NULL,                 -- 楼栋（如 A 栋）
  room       TEXT NOT NULL,                 -- 门牌（如 3-501）
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by TEXT
);

-- 师傅
CREATE TABLE IF NOT EXISTS drivers (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 品牌/水种（带水价与新桶押金标准，分/桶）
CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,   -- 品牌规格，如 农夫山泉 18.9L
  unit_price         INTEGER NOT NULL,       -- 水价（分/桶）
  deposit_per_bucket INTEGER NOT NULL,       -- 新押金桶押金额（分/桶）
  active             INTEGER NOT NULL DEFAULT 1
);

-- 订单主表。押金在送达回执时按「实交空桶/已有押金」据实结算后回写
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY,
  order_no       TEXT NOT NULL UNIQUE,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  order_date     TEXT NOT NULL,
  total_qty      INTEGER NOT NULL,
  deposit_qty    INTEGER NOT NULL DEFAULT 0, -- 本单「押金桶」数量
  own_qty        INTEGER NOT NULL DEFAULT 0, -- 本单「客户自有桶」数量
  water_amount   INTEGER NOT NULL,           -- 水款（分）
  deposit_amount INTEGER NOT NULL DEFAULT 0, -- 回执结算后的新收押金（分）
  total_amount   INTEGER NOT NULL,           -- 应收 = 水款 + 新收押金
  paid_amount    INTEGER NOT NULL DEFAULT 0, -- 已收现（分）
  status         TEXT NOT NULL DEFAULT 'placed', -- placed/dispatched/delivered/cancelled
  driver_id      INTEGER REFERENCES drivers(id),
  remark         TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  assigned_by    TEXT,
  assigned_at    TEXT,
  delivered_at   TEXT,
  cancelled_by   TEXT,
  cancelled_at   TEXT,
  CHECK (status IN ('placed','dispatched','delivered','cancelled')),
  CHECK (total_amount = water_amount + deposit_amount),
  CHECK (paid_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_date ON orders(status, order_date);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);

-- 订单明细：品牌、数量、桶类型（押金桶 / 客户自有桶）分开记
CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('deposit','own')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_price  INTEGER NOT NULL,          -- 下单时水价快照（分）
  deposit_per_bucket INTEGER NOT NULL DEFAULT 0 -- 下单时押金标准快照（分）
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- 送达回执：一单一回执（order_id 唯一），重复录入被数据库直接拦住
CREATE TABLE IF NOT EXISTS receipts (
  id               INTEGER PRIMARY KEY,
  receipt_no       TEXT NOT NULL UNIQUE,
  order_id         INTEGER NOT NULL UNIQUE,
  delivered_qty    INTEGER NOT NULL,       -- 实送桶数
  empty_returned   INTEGER NOT NULL DEFAULT 0, -- 收回空桶数
  new_deposit_qty  INTEGER NOT NULL DEFAULT 0, -- 本次新收押金的桶数
  deposit_amount   INTEGER NOT NULL DEFAULT 0, -- 本次新收押金（分）
  cash_collected   INTEGER NOT NULL DEFAULT 0, -- 本次收现（含水款+押金，分）
  order_building   TEXT NOT NULL,           -- 回单楼栋（开单地址）
  actual_building  TEXT NOT NULL,           -- 实际送达楼栋（送错立刻现形）
  delivered_at     TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  remark           TEXT,
  CHECK (delivered_qty > 0),
  CHECK (empty_returned >= 0),
  CHECK (cash_collected >= 0)
);

-- 押金台账：只增不改。收(collect)/退(refund) 都是新增一行
CREATE TABLE IF NOT EXISTS deposit_ledger (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  direction      TEXT NOT NULL CHECK (direction IN ('collect','refund')),
  qty            INTEGER NOT NULL CHECK (qty > 0),   -- 本行桶数（恒正）
  unit_amount    INTEGER NOT NULL,                   -- 本行口径押金（分/桶）
  amount         INTEGER NOT NULL CHECK (amount > 0),-- 本行金额（恒正，分）
  balance_qty    INTEGER NOT NULL,     -- 记完本行后客户押金桶结余（含正负方向后的净额）
  balance_amount INTEGER NOT NULL,     -- 记完本行后客户押金结余（分）
  source_type    TEXT NOT NULL CHECK (source_type IN ('migration','order','manual_refund')),
  source_id      INTEGER,              -- 回执 id / 订单 id（退桶为回执留空）
  order_id       INTEGER,
  ref_no         TEXT,                 -- 原始收据号（如 2019 老收据）/ 退款单号
  occurred_at    TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  remark         TEXT
);
CREATE INDEX IF NOT EXISTS idx_deposit_customer ON deposit_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_deposit_date ON deposit_ledger(occurred_at);

-- 退款 FIFO 钉到具体的每一笔收款：退的哪年、哪张收据收的桶
CREATE TABLE IF NOT EXISTS deposit_refund_alloc (
  id               INTEGER PRIMARY KEY,
  refund_ledger_id INTEGER NOT NULL REFERENCES deposit_ledger(id),
  collect_ledger_id INTEGER NOT NULL REFERENCES deposit_ledger(id),
  qty              INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_alloc_refund ON deposit_refund_alloc(refund_ledger_id);
CREATE INDEX IF NOT EXISTS idx_alloc_collect ON deposit_refund_alloc(collect_ledger_id);

-- 操作日志：开单/分派/回执/退桶 全部留操作人和时间
CREATE TABLE IF NOT EXISTS action_log (
  id          INTEGER PRIMARY KEY,
  action      TEXT NOT NULL, -- create_order / dispatch_order / create_receipt / refund_deposit / create_customer
  entity_type TEXT,
  entity_id   INTEGER,
  ref_no      TEXT,
  operator    TEXT NOT NULL,
  detail      TEXT,         -- JSON 摘要
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_entity ON action_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_log_action ON action_log(action, created_at);

-- 押金台账不可变：禁止 UPDATE / DELETE（重置库走 DROP/删文件，见 README）
CREATE TRIGGER IF NOT EXISTS trg_deposit_ledger_no_update
BEFORE UPDATE ON deposit_ledger
BEGIN
  SELECT RAISE(ABORT, '押金台账只允许新增（收/退），禁止修改已有记录');
END;

CREATE TRIGGER IF NOT EXISTS trg_deposit_ledger_no_delete
BEFORE DELETE ON deposit_ledger
BEGIN
  SELECT RAISE(ABORT, '押金台账禁止删除，冲正请用反向新单');
END;
