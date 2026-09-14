// 验收脚本：开五单 → 分两师傅 → 三张回执（含重复提交拦截）→ 退两个桶 → 日结对账
// 每次执行自动重置样例库，幂等可重复跑。
const { getDb } = require('../src/db');
const { runSeed } = require('./seed');
const orderService = require('../src/services/orderService');
const depositService = require('../src/services/depositService');
const depositModel = require('../src/models/depositModel');
const reportService = require('../src/services/reportService');
const { DuplicateReceiptError } = require('../src/services/errors');
const { fenToYuan } = require('../src/utils/money');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name} ${detail}\x1b[0m`); }
}
const y = (f) => fenToYuan(f);
const line = (s) => console.log('\n=== ' + s + ' ===');

// 0. 重置样例库
line('0. 重置并灌入样例数据');
runSeed({ reset: true });
const db = getDb();
const custByCode = {};
for (const c of db.prepare('SELECT * FROM customers').all()) custByCode[c.code] = c;
const WANG = 1, LI = 2; // 王建国 / 李大山
const NONG_FU = 1, WA_HA_HA = 2, YI_BAO = 3;
const OPERATOR = '验收员-张敏';

// 1. 开五单
line('1. 开五单');
const oA = orderService.createOrder({ customerId: custByCode.S001.id, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 2 }] });
const oB = orderService.createOrder({ customerId: custByCode.S006.id, operator: OPERATOR,
  items: [{ productId: YI_BAO, bucketType: 'own', qty: 1 }] });
const oC = orderService.createOrder({ customerId: custByCode.S009.id, operator: OPERATOR,
  items: [{ productId: WA_HA_HA, bucketType: 'deposit', qty: 3 }] });
const oD = orderService.createOrder({ customerId: custByCode.S011.id, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 3 }] });
const oE = orderService.createOrder({ customerId: custByCode.S010.id, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 1 }] });
check('开出 5 张单', [oA, oB, oC, oD, oE].every(Boolean));
check('单号连续不重复', new Set([oA.order_no, oB.order_no, oC.order_no, oD.order_no, oE.order_no]).size === 5);
console.log('  单号：', [oA, oB, oC, oD, oE].map((o) => o.order_no).join(' '));

// 2. 分派给两个师傅
line('2. 分派：王建国接 A/D/E，李大山接 B/C');
for (const [o, d] of [[oA, WANG], [oD, WANG], [oE, WANG], [oB, LI], [oC, LI]]) {
  orderService.dispatch({ orderId: o.id, driverId: d, operator: OPERATOR });
}
const afterDispatch = [oA, oB, oC, oD, oE].map((o) => orderService.getById(o.id));
check('5 单全部「已分派」', afterDispatch.every((o) => o.status === 'dispatched'));
check('只涉及两个师傅', new Set(afterDispatch.map((o) => o.driver_id)).size === 2);

// 3. 录三张回执
line('3. 录三张回执（结算逻辑各异）');
// A：周敏账上原有 1 个押金桶，本单 2 押金桶不交空桶 → 抵扣 1、新押 1
const rA = orderService.createReceipt({
  orderId: oA.id, emptyReturned: 0, cashCollected: 9000, operator: '王建国',
});
check('A 水款 40.00 + 新押 1 桶 50.00 = 应收 90.00',
  rA.settlement.totalDue === 9000, `实得 ${y(rA.settlement.totalDue)}`);
check('A 旧押金桶抵扣 1 个、新押金 1 个',
  rA.settlement.coveredQty === 1 && rA.settlement.newDepositQty === 1);

// B：自有桶，无押金
const rB = orderService.createReceipt({
  orderId: oB.id, emptyReturned: 0, cashCollected: 2200, operator: '李大山',
});
check('B 自有桶：押金 0，应收 22.00', rB.settlement.depositAmount === 0 && rB.settlement.totalDue === 2200);

// D：何军账上 1 个 + 当场交回 1 个空桶，3 押金桶 → 新押 1；少付 10 元形成挂账
const rD = orderService.createReceipt({
  orderId: oD.id, emptyReturned: 1, cashCollected: 10000, operator: '王建国',
});
check('D 抵扣 2（旧押1+空桶1）、新押 1',
  rD.settlement.coveredQty === 2 && rD.settlement.newDepositQty === 1,
  `应收 ${y(rD.settlement.totalDue)}，欠 ${y(rD.settlement.unpaid)}`);
check('D 挂账 10.00', rD.settlement.unpaid === 1000);

// C：吴刚账上 8 个 2019 老押金，3 押金桶全部被覆盖，押金为 0（这里先不录回执，保持 3 张）
const cBalance = depositService.getBalance(custByCode.S009.id);
check('吴刚账上 8 个老押金桶（2019 收据）', cBalance.qty === 8 && cBalance.amount === 24000,
  `${cBalance.qty} 桶 / ¥${y(cBalance.amount)}`);

// 4. 重复回执拦截
line('4. 幂等：对 A 单第二次提交回执');
const receiptsBefore = db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
const cashBefore = orderService.getById(oA.id).paid_amount;
let blocked = false;
try {
  orderService.createReceipt({
    orderId: oA.id, emptyReturned: 5, cashCollected: 99999, operator: '王建国',
  });
} catch (e) {
  blocked = e instanceof DuplicateReceiptError;
}
const receiptsAfter = db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
const cashAfter = orderService.getById(oA.id).paid_amount;
check('重复回执被 DuplicateReceiptError 拦下', blocked);
check('回执条数未增加', receiptsBefore === receiptsAfter, `${receiptsBefore} → ${receiptsAfter}`);
check('订单已收现金未变（假数据 999.99 未入账）', cashBefore === cashAfter, `¥${y(cashAfter)}`);
const balA = depositModel.getBalance(custByCode.S001.id);
check('押金台账未多出一行（周敏结余仍 2 桶 / 100.00）', balA.qty === 2 && balA.amount === 10000);

// 5. 退两个桶
line('5. 退桶两笔（金额全部由台账按原收款自动算）');
// 5.1 吴刚退 2 个 → 全部钉到 2019 年收据，按当年 30 元/桶退
const rf1 = depositService.refund({
  customerId: custByCode.S009.id, qty: 2, refNo: 'T-RET-2019-01',
  remark: '客户持 2019 老收据退 2 桶', operator: OPERATOR,
});
check('吴刚退 2 桶 = 60.00（按 2019 年 30 元/桶，不是现价 50）', rf1.totalAmount === 6000,
  `实退 ¥${y(rf1.totalAmount)}`);
const src1 = depositModel.allocationsOf(rf1.refundLedgerIds[0]);
check('退款钉到原始收据 2019-S-0832',
  src1.length === 1 && src1[0].qty === 2 && src1[0].collect_ref_no === '2019-S-0832',
  JSON.stringify(src1.map((s) => ({ 收据: s.collect_ref_no, 桶: s.qty, 标准: y(s.unit_amount) }))));

// 5.2 周敏退 1 个 → FIFO 先消耗一周前最早那笔收款
const rf2 = depositService.refund({
  customerId: custByCode.S001.id, qty: 1, refNo: 'T-RET-TODAY-02',
  remark: '退 1 桶', operator: OPERATOR,
});
check('周敏退 1 桶 = 50.00', rf2.totalAmount === 5000);
const src2 = depositModel.allocationsOf(rf2.refundLedgerIds[0]);
check('FIFO 退的是最早一笔收款（一周前回执，而非今天新收的）',
  src2.length === 1 && src2[0].collect_ref_no && src2[0].collect_ref_no.startsWith('R'),
  `来源收据 ${src2[0] && src2[0].collect_ref_no}（${src2[0] && src2[0].collect_at.slice(0, 10)}）`);

// 5.3 超额退桶必须拒
let overBlocked = false;
try {
  depositService.refund({ customerId: custByCode.S002.id, qty: 1, operator: OPERATOR });
} catch (e) { overBlocked = /不足/.test(e.message); }
check('余额不足退桶被拒（李伟账上 0 桶）', overBlocked);

// 5.4 触发器：直接改押金数字必须被数据库拒绝
let triggerBlocked = false;
try {
  db.prepare('UPDATE deposit_ledger SET amount = 1 WHERE id = 1').run();
} catch (e) { triggerBlocked = /禁止修改/.test(e.message); }
check('直接 UPDATE 押金台账被触发器拒绝', triggerBlocked);

// 6. 日结
line('6. 今日日结：现金 / 未收款 / 押金变动');
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
const rep = reportService.daily(todayStr);
console.log(`  ① 现金：回执收 ¥${y(rep.cash.in)}（水 ¥${y(rep.cash.waterPart)} + 押 ¥${y(rep.cash.depositPart)}）`);
console.log(`          退押支 ¥${y(rep.cash.out)} → 净 ¥${y(rep.cash.net)}`);
console.log(`  ② 今日新增未收款：¥${y(rep.unpaid.todayAmount)}（${rep.unpaid.todayOrders} 单）；累计挂账 ¥${y(rep.unpaid.totalAmount)}`);
console.log(`  ③ 押金：期初 ¥${y(rep.deposit.beginAmount)} ＋收 ¥${y(rep.deposit.collected)} －退 ¥${y(rep.deposit.refunded)} ＝期末 ¥${y(rep.deposit.endAmount)}（${rep.deposit.endQty} 桶）`);
check('现金收入 212.00（90+22+100）', rep.cash.in === 21200);
check('现金退押 110.00（60+50）', rep.cash.out === 11000);
check('现金净流 102.00', rep.cash.net === 10200);
check('今日未收款 10.00', rep.unpaid.todayAmount === 1000);
check('押金新收 100.00 / 退 110.00 / 净 -10.00',
  rep.deposit.collected === 10000 && rep.deposit.refunded === 11000 && rep.deposit.net === -1000);
line('日结自动对账（4 项）');
for (const c of rep.checks) {
  const fmt = (v) => (c.unit === 'fen' ? '¥' + y(v) : v + ' 桶');
  check(c.name, c.pass, `${fmt(c.left)} ${c.pass ? '=' : '≠'} ${fmt(c.right)}`);
}

// 7. 押金台账逐笔溯源
line('7. 今日押金台账每笔钱的源头');
const todayLines = depositModel.list({ date: todayStr });
for (const l of todayLines) {
  let trace = '';
  if (l.direction === 'refund') {
    const allocs = depositModel.allocationsOf(l.id);
    trace = ' ← 退自：' + allocs.map((a) =>
      `${a.collect_at.slice(0, 10)} 收据「${a.collect_ref_no || '无号'}」@¥${y(a.unit_amount)}/桶 × ${a.qty}`).join('；');
  } else {
    trace = ` ← 回执 ${l.ref_no}`;
  }
  console.log(`  [${l.direction === 'collect' ? '收' : '退'}] ${l.customer_name} ${l.qty}桶 × ¥${y(l.unit_amount)} = ¥${y(l.amount)}  结余 ${l.balance_qty}桶/¥${y(l.balance_amount)}${trace}`);
}
check('今日台账共 4 行（2 收 + 2 退）', todayLines.length === 4);

// 8. 全库终极平衡
line('8. 全库押金平衡式');
const signed = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN direction='collect' THEN amount ELSE -amount END),0) amount,
         COALESCE(SUM(CASE WHEN direction='collect' THEN qty ELSE -qty END),0) qty
  FROM deposit_ledger
`).get();
const perCust = db.prepare(`
  SELECT COALESCE(SUM(balance_amount),0) amount, COALESCE(SUM(balance_qty),0) qty FROM (
    SELECT balance_amount, balance_qty, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY id DESC) rn
    FROM deposit_ledger
  ) WHERE rn = 1
`).get();
check('逐行净额 = 各客户滚存余额合计（金额）', signed.amount === perCust.amount,
  `¥${y(signed.amount)}`);
check('逐行净额 = 各客户滚存余额合计（桶数）', signed.qty === perCust.qty, `${signed.qty} 桶`);

// 9. 催单
line('9. 超 24 小时未录回执');
const overdue = orderService.list({ overdue: true });
check('陈强的单在催单列表里', overdue.some((o) => o.customer_code === 'S004'),
  '催单：' + overdue.map((o) => `${o.order_no}/${o.customer_name}`).join(' '));

console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠ 有失败项'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
