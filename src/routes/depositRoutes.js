const express = require('express');
const depositService = require('../services/depositService');
const depositModel = require('../models/depositModel');
const customerModel = require('../models/customerModel');
const { requireOperator } = require('../middleware/operator');
const { NotFoundError } = require('../services/errors');
const v = require('../middleware/validate');

const router = express.Router();

// 押金台账：只增不改的流水
router.get('/', (req, res) => {
  const date = v.asDate(req.query.date, '日期', { optional: true }) || '';
  const customerId = v.asIntOrNull(req.query.customer_id, '客户ID');
  const entries = depositModel.list({ date, customerId });
  // 每行附带退款溯源（退的是哪张收据收的桶）
  for (const e of entries) {
    if (e.direction === 'refund') e.allocations = depositModel.allocationsOf(e.id);
  }
  res.render('deposits/index', {
    entries, customers: customerModel.list(), date, customerId,
  });
});

// 客户押金明细
router.get('/customer/:id', (req, res) => {
  const id = v.asInt(req.params.id, '客户ID', { min: 1 });
  res.redirect(`/customers/${id}#deposit`);
});

// 退桶：数量 + 退款单号（如客户交回的收据号），退多少钱由台账按原收款 FIFO 自动算
router.post('/refund', requireOperator, (req, res, next) => {
  try {
    const customerId = v.asInt(req.body.customer_id, '客户ID', { min: 1 });
    if (!customerModel.getById(customerId)) throw new NotFoundError('客户不存在');
    const result = depositService.refund({
      customerId,
      qty: v.asInt(req.body.qty, '退桶数量', { min: 1 }),
      refNo: v.asString(req.body.ref_no, '退款单号', { optional: true, max: 100 }),
      remark: v.asString(req.body.remark, '备注', { optional: true, max: 500 }),
      operator: req.operator,
    });
    res.redirect(`/customers/${customerId}?refunded=${result.totalAmount}#deposit`);
  } catch (e) { next(e); }
});

module.exports = router;
