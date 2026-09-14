const express = require('express');
const customerModel = require('../models/customerModel');
const customerService = require('../services/customerService');
const driverModel = require('../models/driverModel');
const v = require('../middleware/validate');

const router = express.Router();

// 客户档案列表
router.get('/', (req, res) => {
  const q = v.asString(req.query.q, '搜索词', { optional: true, max: 50 }) || '';
  const customers = q ? customerModel.search(q) : customerModel.list();
  res.render('customers/index', { customers, q });
});

// 客户详情：历史订单 + 桶数 + 押金台账
router.get('/:id', (req, res, next) => {
  try {
    const id = v.asInt(req.params.id, '客户ID', { min: 1 });
    const data = customerService.customerDetail(id);
    const drivers = driverModel.list();
    const refundedFen = req.query.refunded === undefined
      ? null
      : v.asInt(req.query.refunded, '退款金额', { min: 0 });
    res.render('customers/detail', { ...data, drivers, refundedFen });
  } catch (e) { next(e); }
});

module.exports = router;
