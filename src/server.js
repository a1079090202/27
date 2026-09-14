const path = require('path');
const express = require('express');
const config = require('./config');
require('./db').getDb(); // 启动即建表
const { operatorMiddleware } = require('./middleware/operator');
const { fenToYuan } = require('./utils/money');
const customerRoutes = require('./routes/customerRoutes');
const orderRoutes = require('./routes/orderRoutes');
const depositRoutes = require('./routes/depositRoutes');
const bucketRoutes = require('./routes/bucketRoutes');
const reportRoutes = require('./routes/reportRoutes');
const { BusinessError } = require('./services/errors');

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

// 只允许站内路径回跳（以单个 / 开头），堵掉 //evil.com 这类协议相对 URL
function safeBack(value, fallback = '/') {
  if (typeof value !== 'string') return fallback;
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    return value;
  }
  return fallback;
}

// 从 Referer 头取出站内路径（错误页「返回」按钮用）
function refererPath(req) {
  const raw = req.get('referer');
  if (!raw) return '/';
  try {
    const u = new URL(raw);
    return safeBack(u.pathname + u.search, '/');
  } catch {
    return '/';
  }
}

app.get('/operator', (req, res) => {
  const raw = typeof req.query.name === 'string' ? req.query.name : '';
  const name = raw.trim().slice(0, 50);
  if (name) res.setHeader('Set-Cookie', res.locals.setOperatorCookie(name));
  res.redirect(safeBack(req.query.back));
});

app.use('/customers', customerRoutes);
app.use('/orders', orderRoutes);
app.use('/deposits', depositRoutes);
app.use('/buckets', bucketRoutes);
app.use('/', reportRoutes);

// 业务错误统一处理：参数校验 400、重复回执等冲突 409（各错误自带 status）
app.use((err, req, res, next) => {
  if (err instanceof BusinessError) {
    const referer = req.get('referer');
    return res.status(err.status).render('error', {
      message: err.message,
      code: err.code,
      back: refererPath(req),
    });
  }
  console.error(err);
  res.status(500).render('error', { message: '服务器错误', code: 'SERVER_ERROR', back: '/' });
});

app.listen(config.port, () => {
  console.log(`水站台账已启动: http://localhost:${config.port}`);
});

module.exports = app;
