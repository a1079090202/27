// 验收脚本：开五单 → 分两师傅 → 三张回执（含重复提交拦截）→ 退两个桶 → 日结对账
// 每次执行自动重置样例库，幂等可重复跑。
const { getDb } = require('../src/db');
const { runSeed } = require('./seed');
const orderService = require('../src/services/orderService');
const depositService = require('../src/services/depositService');
const depositModel = require('../src/models/depositModel');
const bucketModel = require('../src/models/bucketModel');
const reportService = require('../src/services/reportService');
const closeService = require('../src/services/closeService');
const { DuplicateReceiptError, BusinessError } = require('../src/services/errors');
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
check('A 三段拆分：账上余额抵扣 1、当场空桶抵扣 0、新押 1',
  rA.settlement.coverBalanceQty === 1 && rA.settlement.coverEmptyQty === 0,
  `账上${rA.settlement.coverBalanceQty}/空桶${rA.settlement.coverEmptyQty}/新押${rA.settlement.newDepositQty}`);
// 抵扣必须落地：deposit_offset + FIFO 钉到历史收款批次（周敏一周前 R20260908 收据）
const aTrace = depositModel.offsetTraceByReceipt(rA.receipt.id);
check('A 抵扣落地台账且逐桶钉到历史收据',
  aTrace.length === 1 && aTrace[0].qty === 1 &&
  aTrace[0].allocations.length === 1 && aTrace[0].allocations[0].qty === 1 &&
  aTrace[0].allocations[0].collect_ref_no === 'R20260908-001',
  aTrace.map((o) => o.allocations.map((a) => `${a.collect_ref_no}×${a.qty}`)).join('；'));
check('A 抵扣是担保置换：周敏可退押金余额仍为 2 桶/100 元',
  depositModel.getBalance(custByCode.S001.id).qty === 2);

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
check('D 三段拆分：账上余额抵扣 1、当场空桶抵扣 1、新押 1',
  rD.settlement.coverBalanceQty === 1 && rD.settlement.coverEmptyQty === 1 && rD.settlement.newDepositQty === 1,
  `账上${rD.settlement.coverBalanceQty}/空桶${rD.settlement.coverEmptyQty}/新押${rD.settlement.newDepositQty}`);
const dTrace = depositModel.offsetTraceByReceipt(rD.receipt.id);
check('D 账上抵扣 1 个落地并钉到何军历史收款批次',
  dTrace.length === 1 && dTrace[0].qty === 1 && dTrace[0].allocations[0].collect_ref_no,
  dTrace.map((o) => o.allocations.map((a) => `${a.collect_ref_no}×${a.qty}`)).join('；') || '无抵扣');
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
// 新令牌模型：A 单担保置换已占用该历史收款的直接池，这笔退款必须沿置换链退出
// （via_offset_id 非空、钉到 A 单回执），但钱仍溯源到最早那张一周前收据
const aOffsetId = db.prepare('SELECT id FROM deposit_offset WHERE receipt_id = ?').get(rA.receipt.id).id;
check('退款沿担保置换链退出（via_offset_id 钉到 A 单置换）',
  src2.length === 1 && src2[0].via_offset_id === aOffsetId,
  `via_offset_id=${src2[0] && src2[0].via_offset_id}`);
check('FIFO 钱仍溯源最早收款 R20260908-001（不是今天新收的）',
  src2.length === 1 && src2[0].collect_ref_no === 'R20260908-001',
  `来源收据 ${src2[0] && src2[0].collect_ref_no}（${src2[0] && src2[0].collect_at.slice(0, 10)}）`);

// 5.3 超额退桶必须拒
let overBlocked = false;
try {
  depositService.refund({ customerId: custByCode.S002.id, qty: 1, operator: OPERATOR });
} catch (e) { overBlocked = /不足/.test(e.message); }
check('余额不足退桶被拒（李伟账上 0 桶）', overBlocked);

// 5.4 触发器：直接改/删台账、分配表、回执、已送达订单都必须被数据库拒绝
const expectBlocked = (label, sql, re) => {
  let blockedTrg = false;
  try {
    db.prepare(sql).run();
  } catch (e) { blockedTrg = re.test(e.message); }
  check(label, blockedTrg);
};
const expectAllowed = (label, sql) => {
  try { db.prepare(sql).run(); check(label, true); }
  catch (e) { check(label, false, e.message); }
};
expectBlocked('UPDATE deposit_ledger 被触发器拒绝',
  'UPDATE deposit_ledger SET amount = 1 WHERE id = 1', /禁止修改/);
expectBlocked('DELETE deposit_ledger 被触发器拒绝',
  'DELETE FROM deposit_ledger WHERE id = 1', /禁止删除/);
expectBlocked('UPDATE deposit_offset 被触发器拒绝',
  'UPDATE deposit_offset SET qty = 1 WHERE id = 1', /禁止修改/);
expectBlocked('UPDATE empty_bucket_ledger 被触发器拒绝',
  'UPDATE empty_bucket_ledger SET qty = 1 WHERE id = 1', /禁止修改/);
expectBlocked('UPDATE deposit_refund_alloc 被触发器拒绝（钉源记录不可改）',
  'UPDATE deposit_refund_alloc SET qty = 1 WHERE refund_ledger_id = (SELECT MIN(id) FROM deposit_ledger WHERE direction=\'refund\')', /禁止修改/);
expectBlocked('DELETE deposit_refund_alloc 被触发器拒绝',
  'DELETE FROM deposit_refund_alloc WHERE refund_ledger_id = (SELECT MIN(id) FROM deposit_ledger WHERE direction=\'refund\')', /禁止删除/);
expectBlocked('UPDATE deposit_offset_alloc 被触发器拒绝（钉源记录不可改）',
  'UPDATE deposit_offset_alloc SET qty = 1 WHERE offset_id = 1', /禁止修改/);
expectBlocked('DELETE deposit_offset_alloc 被触发器拒绝',
  'DELETE FROM deposit_offset_alloc WHERE offset_id = 1', /禁止删除/);
expectBlocked('UPDATE receipts 被触发器拒绝（回执是凭证）',
  'UPDATE receipts SET cash_collected = 1 WHERE id = (SELECT MIN(id) FROM receipts)', /禁止修改/);
expectBlocked('DELETE receipts 被触发器拒绝',
  'DELETE FROM receipts WHERE id = (SELECT MIN(id) FROM receipts)', /禁止删除/);
expectBlocked('UPDATE 已送达 orders 被触发器拒绝',
  `UPDATE orders SET remark = '改' WHERE id = ${oA.id}`, /禁止修改/);
expectBlocked('DELETE 已送达 orders 被触发器拒绝',
  `DELETE FROM orders WHERE id = ${oA.id}`, /禁止删除/);
// 在途（dispatched）订单的正常 UPDATE（改派/备注）不得被触发器误杀；此时 C/E 未录回执仍在途
expectAllowed('UPDATE 在途 dispatched 订单不被触发器误杀',
  `UPDATE orders SET remark = '验收脚本触碰在途单' WHERE id = ${oE.id} AND status = 'dispatched'`);
check('触碰后在途单仍为 dispatched', orderService.getById(oE.id).status === 'dispatched');

// 5.5 空桶账实硬约束：凭空多报空桶必须拒（黄娜历史 2 桶全部交回，再开 1 个自有桶单）
line('5.5 空桶账实：多报空桶拦截，且拦截零落地');
const oGhost = orderService.createOrder({ customerId: custByCode.S008.id, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'own', qty: 1 }] });
orderService.dispatch({ orderId: oGhost.id, driverId: 3, operator: OPERATOR });
const receiptsBeforeGhost = db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
const emptyBeforeGhost = db.prepare('SELECT COUNT(*) n FROM empty_bucket_ledger').get().n;
let ghostBlocked = false, ghostMsg = '';
try {
  orderService.createReceipt({
    orderId: oGhost.id, emptyReturned: 50, cashCollected: 2000, operator: '赵晓峰',
  });
} catch (e) { ghostBlocked = e instanceof BusinessError && /账实不符/.test(e.message); ghostMsg = e.message; }
check('黄娜 1 桶单凭空报收回 50 空桶被拒', ghostBlocked, ghostMsg.slice(0, 36));
check('拦截后回执、空桶台账零新增（事务回滚干净）',
  db.prepare('SELECT COUNT(*) n FROM receipts').get().n === receiptsBeforeGhost &&
  db.prepare('SELECT COUNT(*) n FROM empty_bucket_ledger').get().n === emptyBeforeGhost);
// 该单不录合法回执，避免影响今日现金日结口径

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
line(`日结自动对账（${rep.checks.length} 项）`);
for (const c of rep.checks) {
  const fmt = (v) => (c.unit === 'fen' ? '¥' + y(v) : v + ' 桶');
  check(c.name, c.pass, `${fmt(c.left)} ${c.pass ? '=' : '≠'} ${fmt(c.right)}`);
}

// 6.1 空桶实物回收与库存
line('6.1 空桶实物台账：今日回收与累计在库');
console.log(`  送达收回 ${rep.empty.recover} · 退桶交回 ${rep.empty.refundIn} · 今日回站 ${rep.empty.todayTotal} · 全站在库空桶 ${rep.empty.stock}`);
check('今日空桶回站 = 送达收 1（何军）+ 退桶交 3（吴刚2+周敏1）',
  rep.empty.recover === 1 && rep.empty.refundIn === 3 && rep.empty.todayTotal === 4);
check('账上押金桶抵扣置换 2 笔（周敏1 + 何军1）', rep.deposit.offsetQty === 2,
  `${rep.deposit.offsetQty} 笔 / 钉源头 ${rep.deposit.offsetLines} 行`);
check('账实异常户为 0', rep.anomalous.length === 0);

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

// 8.5 补录场景：历史收据补录后，当前余额与历史报表两套口径各归各位
line('8.5 补录：2019 老收据（滚存按插入序、历史按业务时间）');
// 周敏 2026 年已有收退（当前 1 桶/50.00），再补录她 2019 年的 3 桶老收据（当年 30 元/桶）
const asOfDate = '2019-12-31';
const asOfBefore = depositModel.totalBalanceUpTo(asOfDate);
const repBefore = reportService.daily(todayStr);
depositService.migrateCollect({
  customerId: custByCode.S001.id, qty: 3, unitAmount: 3000,
  refNo: '2019-S-0117', occurredAt: '2019-04-12 10:00:00', operator: OPERATOR,
  remark: '验收：周敏 2019 年纸质老收据补录',
});
// 口径一：当前余额（插入序滚存）——补录行滚存 = 1桶/50.00 + 3桶/90.00
const balMig = depositModel.getBalance(custByCode.S001.id);
check('补录后周敏当前余额 4 桶 / 140.00（滚存含 2026 全部业务）',
  balMig.qty === 4 && balMig.amount === 14000, `${balMig.qty} 桶 / ¥${y(balMig.amount)}`);
// 口径二：历史期末（业务时间符号求和）——只 +3 桶/90.00，不含 2026 年业务
const asOfAfter = depositModel.totalBalanceUpTo(asOfDate);
check('2019 期末余额被正确重述：恰好 +3 桶 / +90.00（不含 2026 业务）',
  asOfAfter.qty - asOfBefore.qty === 3 && asOfAfter.amount - asOfBefore.amount === 9000,
  `Δ${asOfAfter.qty - asOfBefore.qty} 桶 / Δ¥${y(asOfAfter.amount - asOfBefore.amount)}`);
// 补录业务日期在 2019：今日变动为 0，期末/期初同步 +90.00，日结对账仍全绿
const repAfter = reportService.daily(todayStr);
check('补录后当日日结对账仍全部平衡', repAfter.allPass);
check('期末/期初同步 +90.00、今日净变动不变',
  repAfter.deposit.endAmount - repBefore.deposit.endAmount === 9000 &&
  repAfter.deposit.beginAmount - repBefore.deposit.beginAmount === 9000 &&
  repAfter.deposit.net === repBefore.deposit.net,
  `净变动 ¥${y(repAfter.deposit.net)}`);

// 8.7 三重支取回归（原假平衡 PoC）+ 新押金足额
line('8.7 令牌模型：同一笔押金不得重复担保；新押金必须足额');
// 用孙磊 S007（账上有 2 个 d-3 新押桶、今日无业务）做独立实验，避免污染其他断言
const G = custByCode.S007.id;
check('实验客户初始直接池 = 净余额 2 桶', depositModel.totalDirectPool(G) === 2);
function gDeliver(empty, cash) {
  const o = orderService.createOrder({ customerId: G, operator: OPERATOR,
    items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 1 }] });
  orderService.dispatch({ orderId: o.id, driverId: WANG, operator: OPERATOR });
  return orderService.createReceipt({ orderId: o.id, emptyReturned: empty, cashCollected: cash, operator: '王建国' });
}
const gr1 = gDeliver(0, 2000); // 水款 2000，1 押金桶全靠担保置换
check('孙磊回执1：账上担保 1、新押 0',
  gr1.settlement.coverBalanceQty === 1 && gr1.settlement.newDepositQty === 0,
  `cover=${gr1.settlement.coverBalanceQty} new=${gr1.settlement.newDepositQty}`);
check('担保后直接池降到 1（净余额仍是 2，在保置换不减余额）',
  depositModel.totalDirectPool(G) === 1 && depositModel.getBalance(G).qty === 2);
const gr2 = gDeliver(0, 2000); // 直接池还够再担保 1，无新押金只收水款
check('孙磊回执2：账上担保 1、新押 0（第二个历史收款批次）',
  gr2.settlement.coverBalanceQty === 1 && gr2.settlement.newDepositQty === 0);
check('直接池耗尽 = 0，净余额仍 2', depositModel.totalDirectPool(G) === 0 && depositModel.getBalance(G).qty === 2);
// 第三张押金桶回执：直接池已空，不能再担保 → 必须新押 1（足额现金 7000=水20+押50）
const gr3 = gDeliver(0, 7000);
check('孙磊回执3：直接池已空，不得重复担保 → cover=0 新押=1',
  gr3.settlement.coverBalanceQty === 0 && gr3.settlement.newDepositQty === 1,
  `cover=${gr3.settlement.coverBalanceQty} new=${gr3.settlement.newDepositQty}`);
// 新押金欠收必须拒：先再送一单把 gr3 新押桶的直接池也担保掉，之后池=0；
// 下一张押金桶单必须新押 1，只交水款 2000 应被拒
const oG4 = orderService.createOrder({ customerId: G, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 1 }] });
orderService.dispatch({ orderId: oG4.id, driverId: WANG, operator: OPERATOR });
const gr4 = orderService.createReceipt({ orderId: oG4.id, emptyReturned: 0, cashCollected: 2000, operator: '王建国' });
check('孙磊回执4：gr3 新押桶进直接池后可再担保 → cover=1 新押=0',
  gr4.settlement.coverBalanceQty === 1 && gr4.settlement.newDepositQty === 0,
  `cover=${gr4.settlement.coverBalanceQty} new=${gr4.settlement.newDepositQty}`);
check('直接池再次耗尽 = 0，净余额 3',
  depositModel.totalDirectPool(G) === 0 && depositModel.getBalance(G).qty === 3);
const oG5 = orderService.createOrder({ customerId: G, operator: OPERATOR,
  items: [{ productId: NONG_FU, bucketType: 'deposit', qty: 1 }] });
orderService.dispatch({ orderId: oG5.id, driverId: WANG, operator: OPERATOR });
let depShortBlocked = false;
try {
  orderService.createReceipt({ orderId: oG5.id, emptyReturned: 0, cashCollected: 2000, operator: '王建国' });
} catch (e) { depShortBlocked = /押金必须足额/.test(e.message); }
check('新押金不足额被拒（池已空，只交水款；水款可挂、押金不可欠）', depShortBlocked);
check('被拒回执零落地（oG5 仍 dispatched）', orderService.getById(oG5.id).status === 'dispatched');
// 水款挂账仍合法：押金 50 足额 + 水款欠 10（收 6000，应收 7000）
const gr5 = (() => {
  const o = orderService.createOrder({ customerId: G, operator: OPERATOR,
    items: [{ productId: NONG_FU, bucketType: 'own', qty: 1 }] });
  orderService.dispatch({ orderId: o.id, driverId: WANG, operator: OPERATOR });
  return orderService.createReceipt({ orderId: o.id, emptyReturned: 0, cashCollected: 1000, operator: '王建国' });
})();
check('纯自有桶单水款挂账仍允许（欠 10.00）', gr5.settlement.unpaid === 1000);
// 担保在保桶的退款必须沿置换链退出（via_offset_id 非空），且退款后直接池不恢复
const grf = depositService.refund({ customerId: G, qty: 1, operator: OPERATOR, refNo: 'T-G-01' });
const gAlloc = db.prepare(`SELECT via_offset_id FROM deposit_refund_alloc WHERE refund_ledger_id = ?`)
  .all(grf.refundLedgerIds[0]);
check('在保置换桶退款经 via_offset_id 钉到具体置换',
  gAlloc.length === 1 && gAlloc[0].via_offset_id !== null, JSON.stringify(gAlloc));
check('退款消耗置换腿后直接池不回流（池仍为 0）', depositModel.totalDirectPool(G) === 0);
check('全库无超额支取', depositModel.overallocations().length === 0,
  JSON.stringify(depositModel.overallocations()));
// 日结仍全平
const repFinal = reportService.daily(todayStr);
check('全部攻击回归后日结仍全部平衡', repFinal.allPass,
  repFinal.checks.filter((c) => !c.pass).map((c) => c.name).join('；'));

// 9. 催单
line('9. 超 24 小时未录回执');
const overdue = orderService.list({ overdue: true });
check('陈强的单在催单列表里', overdue.some((o) => o.customer_code === 'S004'),
  '催单：' + overdue.map((o) => `${o.order_no}/${o.customer_name}`).join(' '));

// 10. 硬封账：全平才能封；封后时间闸拦截补录；快照不可变；漂移可被发现
line('10. 封账与封账后管控');
const closeViewBefore = closeService.buildView(todayStr);
check('封账前今日可封（首封锚点）且对账全平', closeViewBefore.canClose && repFinal.allPass);
const closed = closeService.closeDay(todayStr, OPERATOR);
check('今日封账成功并固化 allPass 快照', !!closed.close && closed.close.all_pass === 1);
let repeatCloseBlocked = false;
try { closeService.closeDay(todayStr, OPERATOR); }
catch (e) { repeatCloseBlocked = /已封账/.test(e.message); }
check('重复封账被拒', repeatCloseBlocked);
// 封账后当日回执被时间闸拦截（零落地）
const receiptsAtClose = db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
let closeReceiptBlocked = false;
try {
  const oX = orderService.createOrder({ customerId: custByCode.S002.id, operator: OPERATOR,
    items: [{ productId: NONG_FU, bucketType: 'own', qty: 1 }] });
  orderService.dispatch({ orderId: oX.id, driverId: LI, operator: OPERATOR });
  orderService.createReceipt({ orderId: oX.id, emptyReturned: 0, cashCollected: 2000, operator: '李大山' });
} catch (e) { closeReceiptBlocked = /已封账/.test(e.message); }
check('封账日后录回执被拒（时间闸）', closeReceiptBlocked);
check('被拒回执零落地（回执条数不变）',
  db.prepare('SELECT COUNT(*) n FROM receipts').get().n === receiptsAtClose);
// 回填到已封的往日也不行
let backdateBlocked = false;
try {
  const oY = orderService.createOrder({ customerId: custByCode.S002.id, operator: OPERATOR,
    items: [{ productId: NONG_FU, bucketType: 'own', qty: 1 }] });
  orderService.dispatch({ orderId: oY.id, driverId: LI, operator: OPERATOR });
  orderService.createReceipt({
    orderId: oY.id, emptyReturned: 0, cashCollected: 2000, operator: '李大山',
    deliveredAt: `${todayStr} 12:00:00`,
  });
} catch (e) { backdateBlocked = /已封账/.test(e.message); }
check('回填业务时间到封账日的回执被拒', backdateBlocked);
// 封账日后退款被拒
let closeRefundBlocked = false;
try { depositService.refund({ customerId: G, qty: 1, operator: OPERATOR }); }
catch (e) { closeRefundBlocked = /已封账/.test(e.message); }
check('封账日后退桶被拒（时间闸）', closeRefundBlocked);
// 快照不可改删
expectBlocked('UPDATE daily_close 快照被触发器拒绝',
  `UPDATE daily_close SET closed_by = 'x' WHERE close_date = '${todayStr}'`, /禁止修改/);
expectBlocked('DELETE daily_close 快照被触发器拒绝',
  `DELETE FROM daily_close WHERE close_date = '${todayStr}'`, /禁止删除/);
// 漂移：migrateCollect 豁免时间闸（补底工具），但封账日重算必须现形
const driftBefore = closeService.buildView(todayStr).drift.length;
depositService.migrateCollect({
  customerId: custByCode.S002.id, qty: 1, unitAmount: 5000, refNo: 'LATE-AUDIT',
  occurredAt: `${todayStr} 18:00:00`, operator: OPERATOR, remark: '封账后补录（审计探针）',
});
const driftAfter = closeService.buildView(todayStr).drift;
check('封账快照初始无漂移', driftBefore === 0, `${driftBefore} 项`);
check('封账区间补录被漂移检测发现', driftAfter.length > 0,
  driftAfter.slice(0, 3).map((d) => d.field).join('、'));
// 未来日期不能封
let futureBlocked = false;
try { closeService.closeDay(closeService.dayAdd(todayStr, 1), OPERATOR); }
catch (e) { futureBlocked = /未来|连续/.test(e.message); }
check('封未来日期被拒', futureBlocked);

console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠ 有失败项'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
