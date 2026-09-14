const path = require('path');
const express = require('express');
const config = require('./config');
require('./db').getDb(); // 启动即建表
const { operatorMiddleware } = require('./middleware/operator');
const { fenToYuan } = require('./utils/money');
const customerRoutes = require('./routes/customerRoutes');
const orderRoutes = require('./routes/orderRoutes');
const depositRoutes = require('./routes/depositRoutes');
const reportRoutes = require('./routes/reportRoutes');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(operatorMiddleware);

// 模板通用助手
app.locals.yuan = fenToYuan;
app.locals.statusText = {
  placed: '待分派', dispatched: '已分派', delivered: '已送达', cancelled: '已取消',
};

app.get('/operator', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name) res.setHeader('Set-Cookie', res.locals.setOperatorCookie(name));
  res.redirect(req.query.back || '/');
});

app.use('/customers', customerRoutes);
app.use('/orders', orderRoutes);
app.use('/deposits', depositRoutes);
app.use('/', reportRoutes);

// 业务错误统一处理（重复回执等）
app.use((err, req, res, next) => {
  if (err && err.name === 'BusinessError') {
    return res.status(409).render('error', {
      message: err.message,
      code: err.code,
      back: req.get('referer') || '/',
    });
  }
  console.error(err);
  res.status(500).render('error', { message: '服务器错误', code: 'SERVER_ERROR', back: '/' });
});

app.listen(config.port, () => {
  console.log(`水站台账已启动: http://localhost:${config.port}`);
});

module.exports = app;
