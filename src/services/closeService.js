const { getDb, nowLocal, todayLocal } = require('../db');
const closeModel = require('../models/closeModel');
const reportService = require('./reportService');
const { BusinessError } = require('./errors');

// 封账：把某一天的日结结果固化为快照。封账链按日期连续（允许零业务日），
// 封账日及以前拒绝回执/退款落入，事后重算与快照不一致即为漂移。
const closeService = {
  dayAdd(date, days) {
    return getDb().prepare(`SELECT date(?, ?) AS d`).get(date, `${days >= 0 ? '+' : ''}${days} day`).d;
  },

  closeDay(date, operator) {
    if (!operator) throw new BusinessError('缺少操作人');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BusinessError('封账日期格式不正确');
    if (date > todayLocal()) throw new BusinessError('不能封未来日期的账');
    if (closeModel.get(date)) throw new BusinessError(`${date} 已封账，不能重复封账`);

    const latest = closeModel.latest();
    if (latest) {
      const expected = closeService.dayAdd(latest.close_date, 1);
      if (date !== expected) {
        throw new BusinessError(`封账必须按日连续：最新封账日 ${latest.close_date}，下一封账日只能是 ${expected}`);
      }
    }

    const report = reportService.daily(date);
    if (!report.allPass) {
      throw new BusinessError('当日自动对账存在不平项，不能封账，请先排查');
    }

    const closedAt = nowLocal();
    getDb().transaction(() => {
      closeModel.insert({
        closeDate: date,
        reportJson: JSON.stringify(report),
        allPass: report.allPass,
        closedBy: operator,
        closedAt,
      });
    })();

    return { close: closeModel.get(date), report };
  },

  // 回执/退款写入前的时间闸：业务日期落入已封区间即拒绝（更正只能走次日）
  assertBusinessDateOpen(bizDate, what = '业务') {
    const latest = closeModel.latest();
    if (latest && bizDate <= latest.close_date) {
      throw new BusinessError(
        `${what}日期 ${bizDate} 已封账（账已封至 ${latest.close_date}），不能补录/冲改；请走次日反向新单`
      );
    }
  },

  // 已封账日的快照与实时重算比对，任何不一致都列为漂移
  drift(closeRow) {
    const snap = JSON.parse(closeRow.report_json);
    const cur = reportService.daily(closeRow.close_date);
    const diffs = [];
    const scalarPaths = [
      ['cash.in', (r) => r.cash.in], ['cash.out', (r) => r.cash.out], ['cash.net', (r) => r.cash.net],
      ['cash.waterPart', (r) => r.cash.waterPart], ['cash.depositPart', (r) => r.cash.depositPart],
      ['unpaid.todayAmount', (r) => r.unpaid.todayAmount],
      ['unpaid.todayWater', (r) => r.unpaid.todayWater],
      ['unpaid.todayDeposit', (r) => r.unpaid.todayDeposit],
      ['unpaid.totalAmount', (r) => r.unpaid.totalAmount],
      ['unpaid.totalWater', (r) => r.unpaid.totalWater],
      ['unpaid.totalDeposit', (r) => r.unpaid.totalDeposit],
      ['deposit.collected', (r) => r.deposit.collected],
      ['deposit.refunded', (r) => r.deposit.refunded],
      ['deposit.net', (r) => r.deposit.net],
      ['deposit.endAmount', (r) => r.deposit.endAmount],
      ['deposit.endQty', (r) => r.deposit.endQty],
      ['deposit.offsetQty', (r) => r.deposit.offsetQty],
      ['empty.recover', (r) => r.empty.recover],
      ['empty.refundIn', (r) => r.empty.refundIn],
      ['empty.todayTotal', (r) => r.empty.todayTotal],
      ['empty.stock', (r) => r.empty.stock],
      ['anomalous.count', (r) => r.anomalous.length],
      ['receipts.count', (r) => r.receipts.length],
      ['refunds.count', (r) => r.refunds.length],
    ];
    for (const [name, get] of scalarPaths) {
      const a = get(snap);
      const b = get(cur);
      if (a !== b) diffs.push({ field: name, snapshot: a, current: b });
    }
    if (snap.checks.length !== cur.checks.length) {
      diffs.push({ field: 'checks.length', snapshot: snap.checks.length, current: cur.checks.length });
    }
    // 全库体检（scope=global）反映的是封账后的当前世界，合法地随时间变化，不参与封账漂移判定
    cur.checks.forEach((c, i) => {
      if (c.scope === 'global') return;
      const s = snap.checks[i];
      if (!s || s.pass !== c.pass || s.left !== c.left || s.right !== c.right) {
        diffs.push({ field: `check[${i + 1}] ${c.name}`, snapshot: s ? `${s.pass}/${s.left}/${s.right}` : '—', current: `${c.pass}/${c.left}/${c.right}` });
      }
    });
    return diffs;
  },

  // 首页看板封账状态：昨天是否已封
  homeStatus() {
    const yesterday = getDb().prepare(`SELECT date('now','localtime','-1 day') AS d`).get().d;
    const latest = closeModel.latest();
    return {
      latestCloseDate: latest ? latest.close_date : null,
      yesterday,
      yesterdayClosed: !!latest && latest.close_date >= yesterday,
    };
  },

  // 日结页视图：实时报告 + 封账行（如有）+ 漂移清单
  buildView(date) {
    const report = reportService.daily(date);
    const close = closeModel.get(date);
    const latest = closeModel.latest();
    let drift = null;
    if (close) drift = closeService.drift(close);
    let nextCloseDate = null;
    if (!latest) nextCloseDate = null; // 尚无封账：任一日可作为首封锚点
    else nextCloseDate = closeService.dayAdd(latest.close_date, 1);
    return {
      report,
      close,
      drift,
      latestCloseDate: latest ? latest.close_date : null,
      nextCloseDate,
      isFuture: date > todayLocal(),
      canClose: !close && date <= todayLocal() && (!latest || date === nextCloseDate),
    };
  },
};

module.exports = closeService;
