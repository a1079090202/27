// 操作人：所有开单/分派/回执/退桶必须带操作人。存 cookie，顶部可切换。
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function operatorMiddleware(req, res, next) {
  const cookies = parseCookies(req);
  req.operator = (cookies.op || '').trim();
  res.locals.operator = req.operator;
  res.locals.originalUrl = req.originalUrl;
  res.locals.setOperatorCookie = (name) =>
    `op=${encodeURIComponent(name)}; Path=/; Max-Age=604800; SameSite=Lax`;
  next();
}

function requireOperator(req, res, next) {
  if (!req.operator) {
    return res.status(400).send('请先在页面顶部选择操作人');
  }
  next();
}

module.exports = { operatorMiddleware, requireOperator, parseCookies };
