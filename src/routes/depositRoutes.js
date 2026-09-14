const express = require('express');
const depositService = require('../services/depositService');
const depositModel = require('../models/depositModel');
const customerModel = require('../models/customerModel');
const { requireOperator } = require('../middleware/operator');

const router = express.Router();

// 押金台账：只增不改的流水
router.get('/', (req, res) => {
  const date = req.query.date || '';
  const customerId = req.query.customer_id ? Number(req.query.customer_id) : null;
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
  res.redirect(`/customers/${req.params.id}#deposit`);
});

// 退桶：数量 + 退款单号（如客户交回的收据号），退多少钱由台账按原收款 FIFO 自动算
router.post('/refund', requireOperator, (req, res, next) => {
  try {
    const result = depositService.refund({
      customerId: Number(req.body.customer_id),
      qty: Number(req.body.qty),
      refNo: req.body.ref_no,
      remark: req.body.remark,
      operator: req.operator,
    });
    res.redirect(`/customers/${req.body.customer_id}?refunded=${result.totalAmount}#deposit`);
  } catch (e) { next(e); }
});

module.exports = router;
