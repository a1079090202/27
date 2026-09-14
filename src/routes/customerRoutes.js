const express = require('express');
const customerModel = require('../models/customerModel');
const customerService = require('../services/customerService');
const driverModel = require('../models/driverModel');

const router = express.Router();

// 客户档案列表
router.get('/', (req, res) => {
  const q = req.query.q || '';
  const customers = q ? customerModel.search(q) : customerModel.list();
  res.render('customers/index', { customers, q });
});

// 客户详情：历史订单 + 桶数 + 押金台账
router.get('/:id', (req, res) => {
  const data = customerService.customerDetail(Number(req.params.id));
  const drivers = driverModel.list();
  const refundedFen = req.query.refunded !== undefined ? Number(req.query.refunded) : null;
  res.render('customers/detail', { ...data, drivers, refundedFen });
});

module.exports = router;
