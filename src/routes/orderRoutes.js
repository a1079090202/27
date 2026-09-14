const express = require('express');
const orderService = require('../services/orderService');
const customerModel = require('../models/customerModel');
const productModel = require('../models/productModel');
const driverModel = require('../models/driverModel');
const { requireOperator } = require('../middleware/operator');

const router = express.Router();

// 订单列表（可按状态/日期/师傅/超24小时筛选）
router.get('/', (req, res) => {
  const filter = {
    status: req.query.status || '',
    date: req.query.date || '',
    driverId: req.query.driver_id ? Number(req.query.driver_id) : null,
    overdue: req.query.overdue === '1',
  };
  const orders = orderService.list(filter);
  const drivers = driverModel.list();
  res.render('orders/index', { orders, drivers, filter });
});

// 开单页
router.get('/new', (req, res) => {
  res.render('orders/new', {
    customers: customerModel.list(),
    products: productModel.list(),
  });
});

// 开单
router.post('/', requireOperator, (req, res, next) => {
  try {
    const b = req.body;
    const items = [];
    const rows = Array.isArray(b.product_id) ? b.product_id : [b.product_id];
    const types = Array.isArray(b.bucket_type) ? b.bucket_type : [b.bucket_type];
    const qtys = Array.isArray(b.qty) ? b.qty : [b.qty];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i] || !qtys[i] || Number(qtys[i]) <= 0) continue;
      items.push({ productId: Number(rows[i]), bucketType: types[i], qty: Number(qtys[i]) });
    }
    const order = orderService.createOrder({
      customerId: Number(b.customer_id),
      items,
      remark: b.remark,
      operator: req.operator,
    });
    res.redirect(`/orders/${order.id}?created=1`);
  } catch (e) { next(e); }
});

// 订单详情
router.get('/:id', (req, res) => {
  const order = orderService.getById(Number(req.params.id));
  if (!order) return res.status(404).render('error', { message: '订单不存在', code: 'NOT_FOUND', back: '/orders' });
  res.render('orders/detail', {
    order, drivers: driverModel.list(),
    created: req.query.created === '1',
    receiptQuery: req.query.receipt === '1',
    wrongQuery: req.query.wrong === '1',
  });
});

// 分派 / 改派
router.post('/:id/dispatch', requireOperator, (req, res, next) => {
  try {
    const order = orderService.getById(Number(req.params.id));
    const driverId = Number(req.body.driver_id);
    if (order.status === 'dispatched') {
      orderService.reassign({ orderId: order.id, driverId, operator: req.operator });
    } else {
      orderService.dispatch({ orderId: order.id, driverId, operator: req.operator });
    }
    res.redirect(`/orders/${order.id}`);
  } catch (e) { next(e); }
});

// 送达回执（幂等：重复提交被服务层+数据库 UNIQUE 双重拦住）
router.post('/:id/receipt', requireOperator, (req, res, next) => {
  try {
    const result = orderService.createReceipt({
      orderId: Number(req.params.id),
      emptyReturned: Number(req.body.empty_returned || 0),
      cashCollected: req.body.cash_collected === '' ? undefined : Math.round(Number(req.body.cash_collected) * 100),
      actualBuilding: req.body.actual_building,
      remark: req.body.remark,
      operator: req.operator,
    });
    res.redirect(`/orders/${result.order.id}?receipt=1${result.settlement.wrongBuilding ? '&wrong=1' : ''}`);
  } catch (e) { next(e); }
});

module.exports = router;
