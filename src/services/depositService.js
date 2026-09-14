const { getDb, nowLocal } = require('../db');
const depositModel = require('../models/depositModel');
const bucketModel = require('../models/bucketModel');
const { logAction } = require('../models/logModel');
const { BusinessError } = require('./errors');
const closeService = require('./closeService');

// 写入后防御性硬闸：任何路径导致收款批次被超额支取（重复抵扣/重复退），立即抛错回滚
function assertNoOverallocation() {
  const bad = depositModel.overallocations();
  if (bad.length) {
    throw new BusinessError(
      `押金批次超额支取：${bad[0].kind === 'collect' ? '收款批次' : '担保置换'} #${bad[0].kind_ref_id} ` +
      `已用 ${bad[0].used} > 原 ${bad[0].qty}，事务已回滚`
    );
  }
}

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
   * 账上押金桶抵扣（担保置换）：回执新押金桶里被「客户账上已有押金桶」覆盖的部分。
   * 旧押金担保从旧桶转到本次新桶——不发生金额移动、不减少可退押金余额，
   * 但必须把每个被置换的桶 FIFO 钉到历史收款批次，并把旧桶按实物交回入空桶台账，
   * 否则同一笔押金能「抵扣一次 + 再现金退一次」形成双重支取。
   * 注意：不在此开事务，随回执事务一起提交/回滚。
   * lines 这里只有「需要用账上余额覆盖多少桶 + 按什么押金标准的新桶」的概念；
   * 溯源只钉历史收款（旧桶当初哪张收据、什么标准），与新桶标准无关。
   * 返回 { offsetId, allocations }
   */
  applyOffset({ customerId, qty, orderId, receiptId, receiptNo, operator, occurredAt }) {
    if (!Number.isInteger(qty) || qty <= 0) return null;
    const balance = depositModel.getBalance(customerId);
    if (balance.qty < qty) {
      throw new BusinessError(
        `账上押金桶不足：要用余额抵扣 ${qty} 个，账上只有 ${balance.qty} 个`
      );
    }
    const open = depositModel.openDirectPools(customerId);
    let need = qty;
    const allocations = [];
    for (const batch of open) {
      if (need <= 0) break;
      const take = Math.min(need, batch.remain_qty);
      allocations.push({ collectLedgerId: batch.id, qty: take });
      need -= take;
    }
    if (need > 0) throw new BusinessError('押金抵扣批次匹配失败（可置换直接池不足），未记账');

    const offsetId = depositModel.insertOffset({
      customerId,
      receiptId,
      orderId,
      qty,
      occurredAt,
      createdBy: operator,
      remark: `账上押金桶抵扣新桶（回执 ${receiptNo}）`,
    });
    for (const a of allocations) {
      depositModel.insertOffsetAlloc(offsetId, a.collectLedgerId, a.qty);
    }
    assertNoOverallocation();

    // 账上余额抵扣是担保置换、物理上不单独回桶，不记空桶实物台账。
    return { offsetId, allocations };
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
      // —— 封账时间闸：退款业务日期不得落入已封账区间 ——
      closeService.assertBusinessDateOpen((occurredAt || nowLocal()).slice(0, 10), '退桶');

      const balance = depositModel.getBalance(customerId);
      if (balance.qty < qty) {
        throw new BusinessError(
          `押金桶余额不足：要退 ${qty} 个，账上只有 ${balance.qty} 个`
        );
      }
      // 账实硬约束：退桶要交回实物空桶，累计交回不能超过该客户历史接收桶数
      if (bucketModel.wouldExceed(customerId, qty)) {
        const pos = bucketModel.position(customerId);
        throw new BusinessError(
          `空桶账实不符：本次再交回 ${qty} 个后累计 ${pos.returned + qty} 个，` +
          `超过该客户历史接收 ${pos.out} 个，拒退请先盘点`
        );
      }
      // 归并 FIFO：按根收款批次顺序，根内先直接池后在保置换；金额由根批次原始标准决定
      const queue = depositModel.refundQueue(customerId);
      let need = qty;

      // 按原始 unit_amount 聚合成退款行
      const groups = new Map();
      const allocations = []; // {collectLedgerId, viaOffsetId, unitAmount, qty}
      for (const leg of queue) {
        if (need <= 0) break;
        const take = Math.min(need, leg.qty);
        allocations.push({
          collectLedgerId: leg.collect_id,
          viaOffsetId: leg.via_offset_id,
          unitAmount: leg.unit_amount,
          qty: take,
        });
        if (!groups.has(leg.unit_amount)) {
          groups.set(leg.unit_amount, { qty: 0, amount: 0 });
        }
        const g = groups.get(leg.unit_amount);
        g.qty += take;
        g.amount += take * leg.unit_amount;
        need -= take;
      }
      if (need > 0) throw new BusinessError('押金批次匹配失败（可退桶数不足），未记账');

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
        const refundId = refundLedgerIds[
          [...groups.keys()].indexOf(alloc.unitAmount)
        ];
        depositModel.insertAllocation(refundId, alloc.collectLedgerId, alloc.qty, alloc.viaOffsetId);
      }
      assertNoOverallocation();

      // 退桶交回的实物空桶入空桶台账（钉到第一行退款，qty 为总退桶数）
      bucketModel.insertMovement({
        customerId,
        movement: 'refund_in',
        qty,
        sourceType: 'refund',
        sourceId: refundLedgerIds[0],
        orderId: null,
        refNo: refNo || null,
        occurredAt,
        createdBy: operator,
        remark: remark || '退桶交回空桶',
      });

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
