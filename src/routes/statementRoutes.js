const express = require('express');
const statementService = require('../services/statementService');
const { todayLocal } = require('../db');
const v = require('../middleware/validate');

const router = express.Router();

// 客户对账单：给客户看的一版账（收/退/置换/抵扣时间线 + 期末三数）
router.get('/customers/:id/statement', (req, res, next) => {
  try {
    const id = v.asInt(req.params.id, '客户ID', { min: 1 });
    const data = statementService.customerStatement(id);
    const print = v.asString(req.query.print, '打印版', { optional: true, max: 5 }) === '1';
    res.render(print ? 'statements/customer_print' : 'statements/customer', data);
  } catch (e) { next(e); }
});

// 月度结算页：当月新收/退还/置换发生额/月末在保，与押金台账逐笔对平
router.get('/statements/monthly', (req, res, next) => {
  try {
    const month = v.asString(req.query.month, '月份', { optional: true, max: 7 }) || todayLocal().slice(0, 7);
    const view = statementService.monthlySettlement(month);
    res.render('statements/monthly', { view });
  } catch (e) { next(e); }
});

module.exports = router;
