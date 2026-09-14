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
  empty_returned   INTEGER NOT NULL DEFAULT 0, -- 当场收回空桶总数（操作员填报，含用于抵扣的旧桶）
  cover_balance_qty INTEGER NOT NULL DEFAULT 0,-- 其中：用客户账上已有押金桶（担保置换）抵扣的桶数
  empty_cover_qty  INTEGER NOT NULL DEFAULT 0, -- 其中：用当场交回空桶抵扣的桶数
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
  CHECK (cover_balance_qty >= 0),
  CHECK (empty_cover_qty >= 0),
  CHECK (new_deposit_qty >= 0),
  CHECK (cash_collected >= 0),
  -- 押金桶去向三段守恒：账上余额抵扣 + 当场空桶抵扣 + 新收押金 = 本单押金桶数
  CHECK (new_deposit_qty + cover_balance_qty + empty_cover_qty <= delivered_qty)
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

-- 退款 FIFO 钉到具体的每一笔收款：退的哪年、哪张收据收的桶。
-- via_offset_id 区分两种退出路径：
--   NULL      直接退：客户账上押金桶直接退现金；
--   非 NULL   置换退出：退的是某笔账上余额担保置换（deposit_offset）在保的桶——
--             该置换当年已用过一次直接池，再轮换只能沿置换链退出，不能二次占用直接池。
--             钱仍钉根 collect（退多少由原始收款标准决定）。
CREATE TABLE IF NOT EXISTS deposit_refund_alloc (
  id               INTEGER PRIMARY KEY,
  refund_ledger_id INTEGER NOT NULL REFERENCES deposit_ledger(id),
  collect_ledger_id INTEGER NOT NULL REFERENCES deposit_ledger(id),
  via_offset_id    INTEGER REFERENCES deposit_offset(id),
  qty              INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_alloc_refund ON deposit_refund_alloc(refund_ledger_id);
CREATE INDEX IF NOT EXISTS idx_alloc_collect ON deposit_refund_alloc(collect_ledger_id);

-- 押金抵扣台账：回执用「账上已有押金桶」抵扣新押金桶时落地。
-- 这是担保置换（旧押金从旧桶转到本次新桶），不发生金额移动、不减少可退押金，
-- 但必须钉到具体历史收款批次，否则同一笔押金能「抵扣一次 + 再现金退一次」双重支取。
-- 只增不改，与 deposit_ledger 同口径。
CREATE TABLE IF NOT EXISTS deposit_offset (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  receipt_id     INTEGER NOT NULL REFERENCES receipts(id),
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  qty            INTEGER NOT NULL CHECK (qty > 0),   -- 本次用账上余额抵扣的桶数
  occurred_at    TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  remark         TEXT
);
CREATE INDEX IF NOT EXISTS idx_offset_customer ON deposit_offset(customer_id);
CREATE INDEX IF NOT EXISTS idx_offset_receipt ON deposit_offset(receipt_id);

-- 抵扣 FIFO 钉源头：每个被抵扣的桶来自哪一张历史收款（与退款 alloc 对称）
CREATE TABLE IF NOT EXISTS deposit_offset_alloc (
  id                INTEGER PRIMARY KEY,
  offset_id         INTEGER NOT NULL REFERENCES deposit_offset(id),
  collect_ledger_id INTEGER NOT NULL REFERENCES deposit_ledger(id),
  qty               INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_offsetalloc_offset ON deposit_offset_alloc(offset_id);
CREATE INDEX IF NOT EXISTS idx_offsetalloc_collect ON deposit_offset_alloc(collect_ledger_id);

-- 空桶实物台账：空桶只在两个通道回站，笔笔落地（只增不改）。
--   recover    回执当场收回空桶（操作员填报的实物数），方向 +1（空桶回站）
--   refund_in  客户退桶时交回空桶，方向 +1
-- 账上押金桶抵扣是「担保置换」（押金从旧桶转到新桶），物理上不单独回桶，故不在此记。
-- 空桶只回站、不出站（再灌装不在本系统），故方向恒为 +；累计收回即全站在库空桶。
CREATE TABLE IF NOT EXISTS empty_bucket_ledger (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  movement       TEXT NOT NULL CHECK (movement IN ('recover','refund_in')),
  qty            INTEGER NOT NULL CHECK (qty > 0),
  source_type    TEXT NOT NULL CHECK (source_type IN ('receipt','refund')),
  source_id      INTEGER,              -- receipt_id / refund ledger id
  order_id       INTEGER,
  ref_no         TEXT,
  occurred_at    TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  remark         TEXT
);
CREATE INDEX IF NOT EXISTS idx_empty_customer ON empty_bucket_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_empty_date ON empty_bucket_ledger(occurred_at);

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

-- 日结封账快照：封账日的完整日结报告（含全部 KPI 与对账结果）固化在此。
-- 封账后该日及以前拒绝任何回执/退款落入（service 层时间闸），事后重算与快照不一致即为漂移。
-- 允许零业务日封账（周末/节假日），保证封账链不断。
CREATE TABLE IF NOT EXISTS daily_close (
  id          INTEGER PRIMARY KEY,
  close_date  TEXT NOT NULL UNIQUE,
  report_json TEXT NOT NULL,            -- 封账时 reportService.daily(date) 的完整 JSON
  all_pass    INTEGER NOT NULL,
  closed_by   TEXT NOT NULL,
  closed_at   TEXT NOT NULL
);

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

-- 抵扣台账、空桶实物台账同样只增不改（冲正走反向新单/整库重置）
CREATE TRIGGER IF NOT EXISTS trg_deposit_offset_no_update
BEFORE UPDATE ON deposit_offset
BEGIN
  SELECT RAISE(ABORT, '押金抵扣台账只允许新增，禁止修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_deposit_offset_no_delete
BEFORE DELETE ON deposit_offset
BEGIN
  SELECT RAISE(ABORT, '押金抵扣台账禁止删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_empty_bucket_no_update
BEFORE UPDATE ON empty_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, '空桶实物台账只允许新增，禁止修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_empty_bucket_no_delete
BEFORE DELETE ON empty_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, '空桶实物台账禁止删除');
END;

-- 两张 FIFO 钉源分配表同样只增不改：直接改分配数字就能把同一笔押金重复支取，
-- 是押金/抵扣台账不可变的必要组成部分。
CREATE TRIGGER IF NOT EXISTS trg_refund_alloc_no_update
BEFORE UPDATE ON deposit_refund_alloc
BEGIN
  SELECT RAISE(ABORT, '退款 FIFO 钉源记录只允许新增，禁止修改');
END;

CREATE TRIGGER IF NOT EXISTS trg_refund_alloc_no_delete
BEFORE DELETE ON deposit_refund_alloc
BEGIN
  SELECT RAISE(ABORT, '退款 FIFO 钉源记录禁止删除');
END;

CREATE TRIGGER IF NOT EXISTS trg_offset_alloc_no_update
BEFORE UPDATE ON deposit_offset_alloc
BEGIN
  SELECT RAISE(ABORT, '抵扣 FIFO 钉源记录只允许新增，禁止修改');
END;

CREATE TRIGGER IF NOT EXISTS trg_offset_alloc_no_delete
BEFORE DELETE ON deposit_offset_alloc
BEGIN
  SELECT RAISE(ABORT, '抵扣 FIFO 钉源记录禁止删除');
END;

-- 回执一经录入即凭证：禁改禁删（冲正走反向新单）。
-- 注意：applyReceiptSettlement 只 UPDATE orders，从不 UPDATE receipts，此触发器不挡正常流程。
CREATE TRIGGER IF NOT EXISTS trg_receipts_no_update
BEFORE UPDATE ON receipts
BEGIN
  SELECT RAISE(ABORT, '回执是已发生凭证，禁止修改；冲正请走反向新单');
END;

CREATE TRIGGER IF NOT EXISTS trg_receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, '回执禁止删除');
END;

-- 已送达订单即历史事实：禁改禁删。placed/dispatched 在途单的分派、改派、
-- 回执结算（OLD.status='dispatched'）均不受影响。
CREATE TRIGGER IF NOT EXISTS trg_orders_delivered_no_update
BEFORE UPDATE ON orders
WHEN OLD.status = 'delivered'
BEGIN
  SELECT RAISE(ABORT, '订单已送达，禁止修改；冲正请走反向新单');
END;

CREATE TRIGGER IF NOT EXISTS trg_orders_delivered_no_delete
BEFORE DELETE ON orders
WHEN OLD.status = 'delivered'
BEGIN
  SELECT RAISE(ABORT, '已送达订单禁止删除');
END;

-- 封账快照一经形成即不可改删（断链修复只能整体走重置/管理员流程，正常使用不开放）
CREATE TRIGGER IF NOT EXISTS trg_daily_close_no_update
BEFORE UPDATE ON daily_close
BEGIN
  SELECT RAISE(ABORT, '封账快照禁止修改');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_close_no_delete
BEFORE DELETE ON daily_close
BEGIN
  SELECT RAISE(ABORT, '封账快照禁止删除');
END;
