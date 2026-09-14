const express = require('express');
const reportService = require('../services/reportService');
const orderService = require('../services/orderService');
const customerService = require('../services/customerService');
const { todayLocal } = require('../db');

const router = express.Router();

// 首页看板：今日概况 + 超24小时未录回执催单
router.get('/', (req, res) => {
  const today = todayLocal();
  const report = reportService.daily(today);
  const overdue = orderService.list({ overdue: true });
  res.render('dashboard', { today, report, overdue });
});

// 日结
router.get('/daily', (req, res) => {
  const date = req.query.date || todayLocal();
  const report = reportService.daily(date);
  res.render('reports/daily', { report });
});

// 客户报电话查历史订单和桶数
router.get('/query', (req, res) => {
  const phone = req.query.phone || '';
  let result = null;
  if (phone) {
    try { result = customerService.queryByPhone(phone); }
    catch (e) { result = { phone, customers: [], error: e.message }; }
  }
  res.render('reports/query', { phone, result });
});

module.exports = router;
