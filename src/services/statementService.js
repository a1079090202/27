const { getDb, nowLocal } = require('../db');
const depositModel = require('../models/depositModel');
const customerModel = require('../models/customerModel');
const closeModel = require('../models/closeModel');
const reportService = require('./reportService');
const { NotFoundError, ValidationError } = require('./errors');

// 对账/结算输出层：客户对账单（能看懂的时间线）+ 月度结算页（与押金台账逐笔对平）。
// 全部只读：不写任何表；所有汇总额外做独立路径交叉勾稽，对不平要点名到具体台账行。
const statementService = {
  /**
   * 客户对账单：按业务时间把「收押金 / 退押金 / 担保置换 / 空桶抵扣」排成一条时间线，
   * 置换行钉死「担保从哪笔收款来」，退款行钉死「退的哪张收据的桶（哪年什么标准）」。
   * 末尾三数：在保桶数 = 直接在保 + 置换占用中；押金余额 = 台账滚存。
   */
  customerStatement(customerId) {
    const customer = customerModel.getById(customerId);
    if (!customer) throw new NotFoundError('客户不存在');
    const db = getDb();

    // —— 四类事件 ——
    // 收/退：押金台账逐行（退行带 FIFO 钉源：哪张收据、什么标准、是否经置换链退出）
    const ledger = depositModel.listByCustomer(customerId);
    // 置换：账上押金桶抵扣（担保置换），钉到历史收款批次 + 对应回执
    const offsets = db.prepare(`
      SELECT o.*, r.receipt_no
      FROM deposit_offset o JOIN receipts r ON r.id = o.receipt_id
      WHERE o.customer_id = ? ORDER BY o.id
    `).all(customerId).map((o) => ({ ...o, allocations: depositModel.offsetAllocationsOf(o.id) }));
    // 空桶抵扣：回执当场交回空桶抵新桶押金（不动押金账，只解释「这次为什么没交押金」）
    const emptyCovers = db.prepare(`
      SELECT r.id, r.receipt_no, r.delivered_at, r.empty_cover_qty, r.order_id, o.order_no
      FROM receipts r JOIN orders o ON o.id = r.order_id
      WHERE o.customer_id = ? AND r.empty_cover_qty > 0
      ORDER BY r.delivered_at, r.id
    `).all(customerId);

    // 同一回执时间戳下的事件顺序：先置换（动用旧担保）→ 空桶抵扣 → 新收押金；退款独立发生
    const KIND_ORDER = { offset: 1, empty_cover: 2, collect: 3, refund: 4 };
    const events = [];
    for (const l of ledger) {
      if (l.direction === 'collect') {
        events.push({
          kind: 'collect', occurredAt: l.occurred_at, sortId: l.id,
          qty: l.qty, unitAmount: l.unit_amount, amount: l.amount,
          refNo: l.ref_no, sourceType: l.source_type, orderId: l.order_id,
          ledgerId: l.id, remark: l.remark,
        });
      } else {
        const allocations = depositModel.allocationsOf(l.id);
        events.push({
          kind: 'refund', occurredAt: l.occurred_at, sortId: l.id,
          qty: l.qty, unitAmount: l.unit_amount, amount: l.amount,
          refNo: l.ref_no, ledgerId: l.id, remark: l.remark,
          allocations,
          viaQty: allocations.filter((a) => a.via_offset_id !== null)
            .reduce((s, a) => s + a.qty, 0),
        });
      }
    }
    for (const o of offsets) {
      events.push({
        kind: 'offset', occurredAt: o.occurred_at, sortId: o.id,
        qty: o.qty, offsetId: o.id, orderId: o.order_id,
        receiptNo: o.receipt_no, allocations: o.allocations,
      });
    }
    for (const e of emptyCovers) {
      events.push({
        kind: 'empty_cover', occurredAt: e.delivered_at, sortId: e.id,
        qty: e.empty_cover_qty, receiptNo: e.receipt_no, orderId: e.order_id,
        orderNo: e.order_no,
      });
    }
    events.sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.sortId - b.sortId)
        : (a.occurredAt < b.occurredAt ? -1 : 1));

    // —— 沿时间线重算三栏结存：在保桶 / 其中置换占用 / 押金余额 ——
    let qty = 0;      // 在保桶数（押金净余额口径：收 − 退）
    let occupied = 0; // 置换占用中（担保已转到新桶、尚未退出的桶）
    let amount = 0;   // 押金余额（分）
    for (const ev of events) {
      if (ev.kind === 'collect') { qty += ev.qty; amount += ev.amount; }
      else if (ev.kind === 'refund') { qty -= ev.qty; amount -= ev.amount; occupied -= ev.viaQty; }
      else if (ev.kind === 'offset') { occupied += ev.qty; }
      // 空桶抵扣不动押金账：当场交回空桶抵了新桶押金，押金没收也没退
      ev.runQty = qty;
      ev.runOccupied = occupied;
      ev.runAmount = amount;
    }

    // —— 期末三数：两条独立路径交叉勾稽，对不上就是算错 ——
    const balance = depositModel.getBalance(customerId);          // 台账滚存（插入序）
    const directPool = depositModel.totalDirectPool(customerId);  // 各收款批次直接池余量合计
    const openOffsets = statementService.openOffsetsOf(customerId);
    const occupiedNow = openOffsets.reduce((s, o) => s + o.remaining_qty, 0);

    const checks = [
      {
        name: '时间线重算在保桶数 = 押金台账滚存桶数', unit: 'qty',
        pass: qty === balance.qty, left: qty, right: balance.qty,
      },
      {
        name: '时间线重算押金余额 = 押金台账滚存余额', unit: 'fen',
        pass: amount === balance.amount, left: amount, right: balance.amount,
      },
      {
        name: '时间线重算置换占用 = 逐笔置换未退出合计', unit: 'qty',
        pass: occupied === occupiedNow, left: occupied, right: occupiedNow,
      },
      {
        // 在保 = 直接在保 + 置换占用中：两类桶数必须勾稽，对不上即算错
        name: '在保桶数 = 直接在保 + 置换占用中', unit: 'qty',
        pass: balance.qty === directPool + occupiedNow,
        left: balance.qty, right: directPool + occupiedNow,
      },
    ];

    return {
      customer,
      events,
      openOffsets,
      summary: {
        qty: balance.qty,
        amount: balance.amount,
        occupiedQty: occupiedNow,
        directQty: directPool,
      },
      checks,
      allPass: checks.every((c) => c.pass),
      generatedAt: nowLocal(),
    };
  },

  // 客户尚未退出的置换占用明细：哪笔置换、还占着几桶、担保来自哪张收据
  openOffsetsOf(customerId) {
    const rows = getDb().prepare(`
      SELECT o.id AS offset_id, o.qty, o.occurred_at, o.order_id, r.receipt_no,
        (SELECT COALESCE(SUM(ra.qty), 0) FROM deposit_refund_alloc ra
          WHERE ra.via_offset_id = o.id) AS exited_qty
      FROM deposit_offset o JOIN receipts r ON r.id = o.receipt_id
      WHERE o.customer_id = ?
      ORDER BY o.id
    `).all(customerId);
    return rows
      .map((o) => ({
        ...o,
        remaining_qty: o.qty - o.exited_qty,
        allocations: depositModel.offsetAllocationsOf(o.offset_id),
      }))
      .filter((o) => o.remaining_qty > 0);
  },

  // 截止某日（含）全站置换占用中桶数：累计置换占用 − 累计经置换退出
  offsetOpenAsOf(date) {
    const db = getDb();
    const occupied = db.prepare(`
      SELECT COALESCE(SUM(oa.qty), 0) AS qty
      FROM deposit_offset_alloc oa JOIN deposit_offset o ON o.id = oa.offset_id
      WHERE date(o.occurred_at) <= ?
    `).get(date).qty;
    const exited = db.prepare(`
      SELECT COALESCE(SUM(ra.qty), 0) AS qty
      FROM deposit_refund_alloc ra JOIN deposit_ledger l ON l.id = ra.refund_ledger_id
      WHERE ra.via_offset_id IS NOT NULL AND date(l.occurred_at) <= ?
    `).get(date).qty;
    return occupied - exited;
  },

  /**
   * 月度结算页：当月新收 / 退还 / 置换发生额 / 月末在保总量，
   * 与押金台账逐笔对平——对不平必须点名差在哪一笔（台账 #id / 置换 #id），
   * 不许笼统报「不平衡」。已封账月份标死，封账快照与重算不一致单独点名日期。
   */
  monthlySettlement(month) {
    if (!/^\d{4}-\d{2}$/.test(month || '')) {
      throw new ValidationError('月份格式应为 YYYY-MM');
    }
    const db = getDb();
    const monthStart = `${month}-01`;
    const bounds = db.prepare(`
      SELECT date(?, '+1 month', '-1 day') AS month_end, date(?, '-1 day') AS prev_end
    `).get(monthStart, monthStart);
    if (!bounds.month_end) throw new ValidationError('月份不是有效日历月');
    const monthEnd = bounds.month_end;
    const prevEnd = bounds.prev_end;

    // 当月台账逐笔（对平的「逐笔」就是它们）
    const lines = db.prepare(`
      SELECT l.*, c.name AS customer_name, c.code AS customer_code
      FROM deposit_ledger l JOIN customers c ON c.id = l.customer_id
      WHERE strftime('%Y-%m', l.occurred_at) = ?
      ORDER BY l.occurred_at, l.id
    `).all(month);
    // 当月置换逐笔（担保置换不动钱，但发生额要列清）
    const offsets = db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code, r.receipt_no
      FROM deposit_offset o
      JOIN customers c ON c.id = o.customer_id
      JOIN receipts r ON r.id = o.receipt_id
      WHERE strftime('%Y-%m', o.occurred_at) = ?
      ORDER BY o.occurred_at, o.id
    `).all(month);
    // 每笔置换的钉源明细（页面展示「担保来自哪笔收款」）
    for (const o of offsets) o.allocations = depositModel.offsetAllocationsOf(o.id);

    // 退款钉源合计 / 置换钉源合计（逐笔完整性核对用）
    const refundAllocSum = new Map(db.prepare(`
      SELECT ra.refund_ledger_id AS id, SUM(ra.qty) AS qty
      FROM deposit_refund_alloc ra GROUP BY ra.refund_ledger_id
    `).all().map((r) => [r.id, r.qty]));
    const offsetAllocSum = new Map(db.prepare(`
      SELECT oa.offset_id AS id, SUM(oa.qty) AS qty, SUM(oa.qty * l.unit_amount) AS amount
      FROM deposit_offset_alloc oa JOIN deposit_ledger l ON l.id = oa.collect_ledger_id
      GROUP BY oa.offset_id
    `).all().map((r) => [r.id, r]));

    // 当月发生额（由逐笔加总，不另写聚合 SQL——同一批行，页面能逐行勾）
    const movement = { collectedQty: 0, collected: 0, refundedQty: 0, refunded: 0, collectLines: 0, refundLines: 0 };
    for (const l of lines) {
      if (l.direction === 'collect') {
        movement.collectedQty += l.qty; movement.collected += l.amount; movement.collectLines += 1;
      } else {
        movement.refundedQty += l.qty; movement.refunded += l.amount; movement.refundLines += 1;
      }
    }
    const offsetQty = offsets.reduce((s, o) => s + o.qty, 0);
    const offsetGuarantee = offsets.reduce((s, o) => s + ((offsetAllocSum.get(o.id) || {}).amount || 0), 0);
    // 当月经置换链退出的桶数（置换占用减少的另一头）
    const offsetExited = db.prepare(`
      SELECT COALESCE(SUM(ra.qty), 0) AS qty
      FROM deposit_refund_alloc ra JOIN deposit_ledger l ON l.id = ra.refund_ledger_id
      WHERE ra.via_offset_id IS NOT NULL AND strftime('%Y-%m', l.occurred_at) = ?
    `).get(month).qty;

    // 月末在保总量：期初 + 当月净变动（路径一） vs 逐日累计（路径二） vs 日结月末日（路径三）
    const opening = depositModel.totalBalanceUpTo(prevEnd);
    const closingActual = depositModel.totalBalanceUpTo(monthEnd);
    const closing = {
      qty: opening.qty + movement.collectedQty - movement.refundedQty,
      amount: opening.amount + movement.collected - movement.refunded,
    };
    const dailyEnd = reportService.daily(monthEnd).deposit;

    // 置换占用勾稽：期初占用 + 当月置换 − 当月置换退出 = 期末占用
    const occupiedBegin = statementService.offsetOpenAsOf(prevEnd);
    const occupiedEnd = statementService.offsetOpenAsOf(monthEnd);

    // —— 逐笔对平：任何一笔对不上都点名 ——
    const discrepancies = [];
    for (const l of lines) {
      if (l.amount !== l.qty * l.unit_amount) {
        discrepancies.push(
          `台账 #${l.id}（${l.occurred_at} ${l.customer_name} ${l.direction === 'collect' ? '收' : '退'} ${l.qty} 桶）：` +
          `金额 ${l.amount} 分 ≠ ${l.qty} 桶 × ${l.unit_amount} 分 = ${l.qty * l.unit_amount} 分`
        );
      }
      if (l.direction === 'refund') {
        const allocQty = refundAllocSum.get(l.id) || 0;
        if (allocQty !== l.qty) {
          discrepancies.push(
            `台账 #${l.id}（${l.occurred_at} ${l.customer_name} 退 ${l.qty} 桶）：` +
            `退款钉源合计 ${allocQty} 桶，差 ${l.qty - allocQty} 桶没有钉到原始收款`
          );
        }
      }
    }
    for (const o of offsets) {
      const alloc = offsetAllocSum.get(o.id);
      if (!alloc || alloc.qty !== o.qty) {
        discrepancies.push(
          `置换 #${o.id}（${o.occurred_at} ${o.customer_name} 回执 ${o.receipt_no} 抵扣 ${o.qty} 桶）：` +
          `钉源合计 ${alloc ? alloc.qty : 0} 桶，差 ${o.qty - (alloc ? alloc.qty : 0)} 桶没有钉到历史收款`
        );
      }
    }

    // 封账状态：整月封死 / 部分封 / 未封；月内封账快照逐日核对（封账后补录在此现形）
    const latest = closeModel.latest();
    const closesInMonth = db.prepare(`
      SELECT * FROM daily_close WHERE close_date BETWEEN ? AND ? ORDER BY close_date
    `).all(monthStart, monthEnd);
    let sealStatus = 'open';
    if (latest) {
      if (latest.close_date >= monthEnd) sealStatus = 'sealed';
      else if (latest.close_date >= monthStart) sealStatus = 'partial';
    }
    for (const c of closesInMonth) {
      const snap = JSON.parse(c.report_json);
      const live = depositModel.totalBalanceUpTo(c.close_date);
      if (snap.deposit.endQty !== live.qty || snap.deposit.endAmount !== live.amount) {
        discrepancies.push(
          `封账日 ${c.close_date}：快照在保 ${snap.deposit.endQty} 桶 / ${snap.deposit.endAmount} 分，` +
          `当前重算 ${live.qty} 桶 / ${live.amount} 分——封账后有人补录/冲改，先查该日漂移`
        );
      }
    }

    const checks = [
      {
        name: '期初 + 当月收 − 当月退 = 月末在保（桶数）', unit: 'qty',
        pass: closing.qty === closingActual.qty, left: closing.qty, right: closingActual.qty,
      },
      {
        name: '期初 + 当月收 − 当月退 = 月末在保（金额）', unit: 'fen',
        pass: closing.amount === closingActual.amount, left: closing.amount, right: closingActual.amount,
      },
      {
        name: `月末在保 = 日结（${monthEnd}）在保（桶数）`, unit: 'qty',
        pass: closingActual.qty === dailyEnd.endQty, left: closingActual.qty, right: dailyEnd.endQty,
      },
      {
        name: `月末在保 = 日结（${monthEnd}）在保（金额）`, unit: 'fen',
        pass: closingActual.amount === dailyEnd.endAmount, left: closingActual.amount, right: dailyEnd.endAmount,
      },
      {
        name: '置换占用勾稽：期初占用 + 当月置换 − 当月置换退出 = 期末占用', unit: 'qty',
        pass: occupiedBegin + offsetQty - offsetExited === occupiedEnd,
        left: occupiedBegin + offsetQty - offsetExited, right: occupiedEnd,
      },
      {
        name: '期末置换占用 ≤ 期末在保（占用是在保的子集）', unit: 'qty',
        pass: occupiedEnd <= closingActual.qty, left: occupiedEnd, right: closingActual.qty,
      },
      {
        name: '当月台账逐笔金额钉死（金额 = 桶数 × 单桶标准）', unit: 'qty',
        pass: !discrepancies.some((d) => d.startsWith('台账 #') && d.includes('≠')),
        left: discrepancies.filter((d) => d.startsWith('台账 #') && d.includes('≠')).length, right: 0,
      },
      {
        name: '当月退款逐笔钉源齐全（钉源桶数 = 退款桶数）', unit: 'qty',
        pass: !discrepancies.some((d) => d.includes('没有钉到原始收款')),
        left: discrepancies.filter((d) => d.includes('没有钉到原始收款')).length, right: 0,
      },
      {
        name: '当月置换逐笔钉源齐全（钉源桶数 = 置换桶数）', unit: 'qty',
        pass: !discrepancies.some((d) => d.includes('没有钉到历史收款')),
        left: discrepancies.filter((d) => d.includes('没有钉到历史收款')).length, right: 0,
      },
      {
        name: '月内封账快照与当前重算一致（无封账后补录）', unit: 'qty',
        pass: !discrepancies.some((d) => d.startsWith('封账日')),
        left: discrepancies.filter((d) => d.startsWith('封账日')).length, right: 0,
      },
    ];

    return {
      month, monthStart, monthEnd,
      daysInMonth: Number(monthEnd.slice(8, 10)),
      movement,
      offset: {
        qty: offsetQty, lines: offsets.length, guaranteeAmount: offsetGuarantee,
        exitedQty: offsetExited, beginQty: occupiedBegin, endQty: occupiedEnd,
      },
      opening, closing, closingActual,
      dailyEnd: { qty: dailyEnd.endQty, amount: dailyEnd.endAmount },
      lines, offsets,
      seal: {
        status: sealStatus,
        latestCloseDate: latest ? latest.close_date : null,
        closedDays: closesInMonth.length,
        closes: closesInMonth.map((c) => ({ date: c.close_date, by: c.closed_by, at: c.closed_at })),
      },
      checks,
      discrepancies,
      allPass: checks.every((c) => c.pass),
      generatedAt: nowLocal(),
    };
  },
};

module.exports = statementService;
