const express = require('express');
const reportService = require('../services/reportService');
const closeService = require('../services/closeService');
const orderService = require('../services/orderService');
const customerService = require('../services/customerService');
const { todayLocal } = require('../db');
const v = require('../middleware/validate');
const { requireOperator } = require('../middleware/operator');

const router = express.Router();

// 首页看板：今日概况 + 超24小时未录回执催单
router.get('/', (req, res) => {
  const today = todayLocal();
  const report = reportService.daily(today);
  const overdue = orderService.list({ overdue: true });
  const closeInfo = closeService.buildView(today);
  const closeStatus = closeService.homeStatus();
  res.render('dashboard', { today, report, overdue, closeInfo, closeStatus });
});

// 日结
router.get('/daily', (req, res) => {
  const date = v.asDate(req.query.date, '日期', { optional: true }) || todayLocal();
  const view = closeService.buildView(date);
  res.render('reports/daily', { view });
});

// 封账：当日自动对账全平方可封，封账后该日及以前不可再补录
router.post('/daily/close', requireOperator, (req, res, next) => {
  try {
    const date = v.asDate(req.body.date, '日期', { optional: true }) || todayLocal();
    closeService.closeDay(date, req.operator);
    res.redirect(`/daily?date=${date}&closed=1`);
  } catch (e) { next(e); }
});

// 客户报电话查历史订单和桶数
router.get('/query', (req, res) => {
  const phone = v.asString(req.query.phone, '电话', { optional: true, max: 20 }) || '';
  let result = null;
  if (phone) {
    try { result = customerService.queryByPhone(phone); }
    catch (e) { result = { phone, customers: [], error: e.message }; }
  }
  res.render('reports/query', { phone, result });
});

module.exports = router;
