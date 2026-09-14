// 样例数据：12 客户、3 师傅、一周订单/回执/退桶
// 用法：node scripts/seed.js --reset
const fs = require('fs');
const config = require('../src/config');
const { getDb } = require('../src/db');
const customerModel = require('../src/models/customerModel');
const orderService = require('../src/services/orderService');
const depositService = require('../src/services/depositService');

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const PRODUCTS = [
  { name: '农夫山泉 18.9L', unit_price: 2000, deposit_per_bucket: 5000 },
  { name: '娃哈哈 18.9L', unit_price: 1800, deposit_per_bucket: 5000 },
  { name: '怡宝 18.9L', unit_price: 2200, deposit_per_bucket: 5000 },
];

const DRIVERS = [
  { code: 'D01', name: '王建国', phone: '139-1111-0001' },
  { code: 'D02', name: '李大山', phone: '139-1111-0002' },
  { code: 'D03', name: '赵晓峰', phone: '139-1111-0003' },
];

const CUSTOMERS = [
  { code: 'S001', name: '周敏', phone: '13800000001', building: 'A栋', room: '1-101' },
  { code: 'S002', name: '李伟', phone: '13800000002', building: 'A栋', room: '1-202' },
  { code: 'S003', name: '王芳', phone: '13800000003', building: 'B栋', room: '2-301' },
  { code: 'S004', name: '陈强', phone: '13800000004', building: 'B栋', room: '2-402' },
  { code: 'S005', name: '刘洋', phone: '13800000005', building: 'C栋', room: '3-101' },
  { code: 'S006', name: '张莉', phone: '13800000006', building: 'C栋', room: '3-202' },
  { code: 'S007', name: '孙磊', phone: '13800000007', building: 'A栋', room: '1-303' },
  { code: 'S008', name: '黄娜', phone: '13800000008', building: 'B栋', room: '2-501' },
  { code: 'S009', name: '吴刚', phone: '13800000009', building: 'C栋', room: '3-303' },
  { code: 'S010', name: '郑洁', phone: '13800000010', building: 'A栋', room: '1-404' },
  { code: 'S011', name: '何军', phone: '13800000011', building: 'B栋', room: '2-602' },
  { code: 'S012', name: '郭静', phone: '13800000012', building: 'C栋', room: '3-404' },
];

function resetDb() {
  for (const f of [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function runSeed({ reset = false } = {}) {
  if (reset) resetDb();
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) AS n FROM customers`).get().n;
  if (existing > 0 && !reset) {
    throw new Error('库里已有数据；如需重置请用 --reset（会删除现有数据库文件）');
  }

  const CLERK = '张敏';

  // 品牌、师傅
  const insProduct = db.prepare(
    `INSERT INTO products (name, unit_price, deposit_per_bucket) VALUES (?, ?, ?)`
  );
  for (const p of PRODUCTS) insProduct.run(p.name, p.unit_price, p.deposit_per_bucket);
  const insDriver = db.prepare(
    `INSERT INTO drivers (code, name, phone) VALUES (?, ?, ?)`
  );
  for (const d of DRIVERS) insDriver.run(d.code, d.name, d.phone);

  // 客户
  const customers = {};
  for (const c of CUSTOMERS) {
    customers[c.code] = customerModel.create({ ...c, createdBy: CLERK });
  }

  // 2019 年老收据补底：吴刚 8 个押金桶，当年标准 30 元/桶
  depositService.migrateCollect({
    customerId: customers.S009.id,
    qty: 8,
    unitAmount: 3000,
    refNo: '2019-S-0832',
    occurredAt: '2019-06-18 09:30:00',
    operator: CLERK,
    remark: '2019 年纸质老收据补录，8 个空桶押金 @30 元',
  });

  const pid = { nongfu: 1, wahaha: 2, yibao: 3 };
  const did = { wang: 1, li: 2, zhao: 3 };

  // 一周订单：[偏移天数, 客户, 明细, 师傅, 收回空桶, 实收现(分,不传=全额), 实际楼栋]
  const plans = [
    [-6, 'S001', [{ p: pid.nongfu, t: 'deposit', q: 2 }], did.wang, 0],
    [-6, 'S002', [{ p: pid.wahaha, t: 'deposit', q: 1 }, { p: pid.yibao, t: 'own', q: 1 }], did.li, 1],
    [-5, 'S003', [{ p: pid.nongfu, t: 'deposit', q: 1 }], did.zhao, 0, null, 'A栋'], // 回单 B栋，实送 A栋，送错
    [-5, 'S005', [{ p: pid.yibao, t: 'own', q: 2 }], did.wang, 0, 4000],           // 应收 4400，欠 400
    [-4, 'S006', [{ p: pid.nongfu, t: 'deposit', q: 1 }], did.li, 0],
    [-3, 'S007', [{ p: pid.nongfu, t: 'deposit', q: 3 }], did.wang, 1],            // 3 押金桶，交回 1 空桶，只押 2
    [-3, 'S008', [{ p: pid.wahaha, t: 'own', q: 2 }], did.zhao, 2],
    [-2, 'S010', [{ p: pid.nongfu, t: 'deposit', q: 1 }, { p: pid.yibao, t: 'own', q: 1 }], did.li, 0],
    [-1, 'S011', [{ p: pid.nongfu, t: 'deposit', q: 1 }], did.wang, 0],
  ];

  for (let i = 0; i < plans.length; i++) {
    const [off, custCode, items, driverId, empty, cash, actual] = plans[i];
    const date = dateOffset(off);
    const order = orderService.createOrder({
      customerId: customers[custCode].id,
      items: items.map((x) => ({ productId: x.p, bucketType: x.t, qty: x.q })),
      operator: CLERK,
      orderDate: date,
    });
    orderService.dispatch({ orderId: order.id, driverId, operator: CLERK });
    const hh = 9 + (i % 8);
    orderService.createReceipt({
      orderId: order.id,
      emptyReturned: empty,
      cashCollected: cash,
      actualBuilding: actual || undefined,
      operator: DRIVERS[driverId - 1].name,
      deliveredAt: `${date} ${String(hh).padStart(2, '0')}:15:00`,
    });
  }

  // 一周中间退过 1 个桶：周敏 d-4 退 1（@50 元，来自 d-6 回执收款）
  depositService.refund({
    customerId: customers.S001.id,
    qty: 1,
    refNo: 'T-2026-0001',
    remark: '客户搬家退 1 桶',
    operator: CLERK,
    occurredAt: `${dateOffset(-4)} 15:20:00`,
  });

  // 一单超过 24 小时未录回执：陈强，3 天前开单、2 天前分派给李大山，至今未送达
  const stale = orderService.createOrder({
    customerId: customers.S004.id,
    items: [{ productId: pid.nongfu, bucketType: 'deposit', qty: 1 }],
    operator: CLERK,
    orderDate: dateOffset(-3),
  });
  orderService.dispatch({ orderId: stale.id, driverId: did.li, operator: CLERK });
  db.prepare(`UPDATE orders SET created_at = ?, assigned_at = ? WHERE id = ?`)
    .run(`${dateOffset(-3)} 09:05:00`, `${dateOffset(-2)} 08:30:00`, stale.id);

  return { customers, db };
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  const { db } = runSeed({ reset });
  const counts = {
    customers: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
    drivers: db.prepare('SELECT COUNT(*) n FROM drivers').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    receipts: db.prepare('SELECT COUNT(*) n FROM receipts').get().n,
    depositLines: db.prepare('SELECT COUNT(*) n FROM deposit_ledger').get().n,
  };
  console.log('样例数据就绪：', counts);
  console.log(`数据库文件：${config.dbFile}`);
}

module.exports = { runSeed, dateOffset, CUSTOMERS, DRIVERS, PRODUCTS };
