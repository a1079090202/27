const express = require('express');
const bucketModel = require('../models/bucketModel');
const customerModel = require('../models/customerModel');
const { todayLocal } = require('../db');
const v = require('../middleware/validate');

const router = express.Router();

// 空桶实物台账：回执收回 + 退桶交回，只增不改
router.get('/', (req, res) => {
  const date = v.asDate(req.query.date, '日期', { optional: true }) || '';
  const customerId = v.asIntOrNull(req.query.customer_id, '客户ID');
  const entries = bucketModel.list({ date, customerId });
  const movementDate = date || todayLocal();
  const todayMove = bucketModel.dailyMovement(movementDate);
  const stock = bucketModel.stockUpTo(movementDate);
  res.render('buckets/index', {
    entries, customers: customerModel.list(), date, customerId, todayMove, stock,
  });
});

module.exports = router;
