const express = require('express');
const orderService = require('../services/orderService');
const customerModel = require('../models/customerModel');
const productModel = require('../models/productModel');
const driverModel = require('../models/driverModel');
const depositModel = require('../models/depositModel');
const { requireOperator } = require('../middleware/operator');
const v = require('../middleware/validate');

const router = express.Router();

const ORDER_STATUSES = ['placed', 'dispatched', 'delivered', 'cancelled'];

// 订单列表（可按状态/日期/师傅/超24小时筛选）
router.get('/', (req, res) => {
  const filter = {
    status: v.asOneOf(req.query.status, ORDER_STATUSES, '订单状态', { optional: true }) || '',
    date: v.asDate(req.query.date, '日期', { optional: true }) || '',
    driverId: v.asIntOrNull(req.query.driver_id, '师傅ID'),
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
    const customerId = v.asInt(b.customer_id, '客户ID', { min: 1 });
    const rows = v.asArray(b.product_id);
    const types = v.asArray(b.bucket_type);
    const qtys = v.asArray(b.qty);

    const items = [];
    for (let i = 0; i < rows.length; i++) {
      // 与原逻辑一致：空行/非正数量行静默跳过，只留合法行（全不合法由服务层拦）
      if (v.isEmpty(rows[i]) || v.isEmpty(qtys[i])) continue;
      const qty = v.asInt(qtys[i], '数量', { min: 1 });
      const bucketType = v.asOneOf(types[i], ['deposit', 'own'], '桶类型');
      items.push({ productId: v.asInt(rows[i], '水种ID', { min: 1 }), bucketType, qty });
    }

    const order = orderService.createOrder({
      customerId,
      items,
      remark: v.asString(b.remark, '备注', { optional: true, max: 500 }),
      operator: req.operator,
    });
    res.redirect(`/orders/${order.id}?created=1`);
  } catch (e) { next(e); }
});

// 订单详情
router.get('/:id', (req, res) => {
  const id = v.asInt(req.params.id, '订单ID', { min: 1 });
  const order = orderService.getById(id);
  if (!order) return res.status(404).render('error', { message: '订单不存在', code: 'NOT_FOUND', back: '/orders' });
  // 已送达：附抵扣置换溯源（账上余额抵扣的桶来自哪些历史收据）
  let offsetTrace = [];
  if (order.receipt) {
    offsetTrace = depositModel.offsetTraceByReceipt(order.receipt.id);
  }
  res.render('orders/detail', {
    order, drivers: driverModel.list(), offsetTrace,
    created: req.query.created === '1',
    receiptQuery: req.query.receipt === '1',
    wrongQuery: req.query.wrong === '1',
  });
});

// 分派 / 改派
router.post('/:id/dispatch', requireOperator, (req, res, next) => {
  try {
    const orderId = v.asInt(req.params.id, '订单ID', { min: 1 });
    const driverId = v.asInt(req.body.driver_id, '师傅ID', { min: 1 });
    const order = orderService.getById(orderId);
    if (!order) {
      return res.status(404).render('error', { message: '订单不存在', code: 'NOT_FOUND', back: '/orders' });
    }
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
      orderId: v.asInt(req.params.id, '订单ID', { min: 1 }),
      emptyReturned: v.asInt(req.body.empty_returned, '收回空桶数', { min: 0, optional: true }) ?? 0,
      cashCollected: v.asFenOptional(req.body.cash_collected, '收款金额'),
      actualBuilding: v.asString(req.body.actual_building, '实际楼栋', { optional: true, max: 100 }),
      remark: v.asString(req.body.remark, '备注', { optional: true, max: 500 }),
      operator: req.operator,
    });
    res.redirect(`/orders/${result.order.id}?receipt=1${result.settlement.wrongBuilding ? '&wrong=1' : ''}`);
  } catch (e) { next(e); }
});

module.exports = router;
