const { getDb, nowLocal } = require('../db');
const depositModel = require('../models/depositModel');
const { logAction } = require('../models/logModel');
const { BusinessError } = require('./errors');

const depositService = {
  /**
   * 回执送达时收押金：每个押金标准一行（正常全站统一标准，只有一行）。
   * lines: [{ qty, unitAmount }]
   * 返回 { ledgerIds, totalAmount, totalQty }
   */
  collectOnReceipt({ customerId, lines, orderId, receiptId, receiptNo, operator, occurredAt }) {
    const ids = [];
    let totalAmount = 0;
    let totalQty = 0;
    for (const ln of lines.filter((x) => x.qty > 0)) {
      const amount = ln.qty * ln.unitAmount;
      const id = depositModel.insertEntry({
        customerId,
        direction: 'collect',
        qty: ln.qty,
        unitAmount: ln.unitAmount,
        amount,
        sourceType: 'order',
        sourceId: receiptId,
        orderId,
        refNo: receiptNo,
        occurredAt,
        createdBy: operator,
        remark: '送达回执新收押金桶',
      });
      ids.push(id);
      totalAmount += amount;
      totalQty += ln.qty;
    }
    return { ledgerIds: ids, totalAmount, totalQty };
  },

  /**
   * 退桶：按 FIFO 消耗尚未退完的收款批次，每个原始押金标准生成一行退款，
   * 并在 deposit_refund_alloc 里钉死「这次退的桶来自哪张收据」。
   * 退多少钱完全由原始收款决定——退的桶当初交了多少就退多少。
   */
  refund({ customerId, qty, operator, refNo, remark, occurredAt }) {
    if (!Number.isInteger(qty) || qty <= 0) throw new BusinessError('退桶数量必须是正整数');
    occurredAt = occurredAt || nowLocal();

    const db = getDb();
    return db.transaction(() => {
      const balance = depositModel.getBalance(customerId);
      if (balance.qty < qty) {
        throw new BusinessError(
          `押金桶余额不足：要退 ${qty} 个，账上只有 ${balance.qty} 个`
        );
      }
      const open = depositModel.openCollects(customerId);
      let need = qty;

      // 按原始 unit_amount 聚合成退款行
      const groups = new Map();
      const allocations = []; // {collectLedgerId, qty}
      for (const batch of open) {
        if (need <= 0) break;
        const take = Math.min(need, batch.remain_qty);
        allocations.push({ collectLedgerId: batch.id, qty: take });
        if (!groups.has(batch.unit_amount)) {
          groups.set(batch.unit_amount, { qty: 0, amount: 0 });
        }
        const g = groups.get(batch.unit_amount);
        g.qty += take;
        g.amount += take * batch.unit_amount;
        need -= take;
      }
      if (need > 0) throw new BusinessError('押金批次匹配失败（FIFO 余额不足），未记账');

      const refundLedgerIds = [];
      let totalAmount = 0;
      let seq = 0;
      for (const [unitAmount, g] of groups) {
        seq += 1;
        const id = depositModel.insertEntry({
          customerId,
          direction: 'refund',
          qty: g.qty,
          unitAmount: unitAmount,
          amount: g.amount,
          sourceType: 'manual_refund',
          sourceId: null,
          orderId: null,
          refNo: refNo || null,
          occurredAt,
          createdBy: operator,
          remark: (remark ? remark + '；' : '') + `退桶退款（第 ${seq}/${groups.size} 组）`,
        });
        refundLedgerIds.push(id);
        totalAmount += g.amount;
      }

      // 退款行与收款批次的对应（同标准时只有一行，直接钉；多组时按标准归并）
      for (const alloc of allocations) {
        const batch = open.find((b) => b.id === alloc.collectLedgerId);
        const refundId = refundLedgerIds[
          [...groups.keys()].indexOf(batch.unit_amount)
        ];
        depositModel.insertAllocation(refundId, alloc.collectLedgerId, alloc.qty);
      }

      logAction({
        action: 'refund_deposit',
        entityType: 'customer',
        entityId: customerId,
        refNo: refNo || null,
        operator,
        detail: { qty, totalAmount, refundLedgerIds, allocations, remark: remark || null },
      });

      return { qty, totalAmount, refundLedgerIds, allocations, occurredAt };
    })();
  },

  // 历史押金录入（如 2019 年老收据补底）：只许收，不许写假余额
  migrateCollect({ customerId, qty, unitAmount, refNo, occurredAt, operator, remark }) {
    if (!Number.isInteger(qty) || qty <= 0) throw new BusinessError('桶数必须是正整数');
    if (!Number.isInteger(unitAmount) || unitAmount <= 0) throw new BusinessError('单桶押金必须为正整数（分）');
    return getDb().transaction(() => {
      const id = depositModel.insertEntry({
        customerId,
        direction: 'collect',
        qty,
        unitAmount: unitAmount,
        amount: qty * unitAmount,
        sourceType: 'migration',
        sourceId: null,
        orderId: null,
        refNo: refNo || null,
        occurredAt: occurredAt || nowLocal(),
        createdBy: operator,
        remark: remark || '历史押金补录',
      });
      logAction({
        action: 'migrate_deposit',
        entityType: 'deposit_ledger',
        entityId: id,
        refNo: refNo || null,
        operator,
        detail: { customerId, qty, unitAmount, occurredAt },
      });
      return id;
    })();
  },

  getBalance(customerId) {
    return depositModel.getBalance(customerId);
  },
};

module.exports = depositService;
