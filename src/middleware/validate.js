const { ValidationError } = require('../services/errors');

// 路由层入参校验：所有从 query/body/params 进来的值先过这里，
// 非法输入抛 ValidationError（400），不许带着 NaN/对象进模型层炸 SQL 绑定。

function isEmpty(v) {
  return v === undefined || v === null || v === '';
}

// 字符串：拒绝 qs 解析出的对象/数组（如 remark[x]=1），限长
function asString(value, label, { max = 200, optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${label}格式不正确`);
  const s = value.trim();
  if (!s) return optional ? undefined : '';
  if (s.length > max) throw new ValidationError(`${label}长度不能超过 ${max} 个字符`);
  return s;
}

// 整数：只接受数字或纯数字字符串，拒绝对象/数组/小数/NaN/Infinity
function asInt(value, label, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (isEmpty(value)) {
    if (optional) return undefined;
    throw new ValidationError(`缺少${label}`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${label}必须是数字`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError(`${label}必须是整数`);
  if (n < min || n > max) {
    throw new ValidationError(`${label}必须在 ${min}~${max} 之间`);
  }
  return n;
}

// 可空整数 query：空串/缺省 → null
function asIntOrNull(value, label, { min = 1 } = {}) {
  if (isEmpty(value)) return null;
  return asInt(value, label, { min });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 本地日期 YYYY-MM-DD（空串放行，由调用方给默认值）
function asDate(value, label = '日期', { optional = false } = {}) {
  const s = asString(value, label, { optional });
  if (!s) return optional ? undefined : '';
  if (!DATE_RE.test(s)) throw new ValidationError(`${label}格式应为 YYYY-MM-DD`);
  // 拒绝 2026-99-99 这种日历上不存在的日期（按本地分量比较，避免 UTC 错位）
  const [y, m, dd] = s.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== dd) {
    throw new ValidationError(`${label}不是有效日期`);
  }
  return s;
}

// 金额（元，表单输入）→ 分（整数）。空 → undefined（业务上表示按应收默认）
function asFenOptional(value, label = '金额') {
  if (isEmpty(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${label}格式不正确`);
  }
  const yuan = Number(value);
  if (!Number.isFinite(yuan) || yuan < 0) throw new ValidationError(`${label}必须是不小于 0 的数字`);
  return Math.round(yuan * 100);
}

// 白名单枚举（空串放行）
function asOneOf(value, allowed, label, { optional = false } = {}) {
  const s = asString(value, label, { optional });
  if (!s) return optional ? undefined : '';
  if (!allowed.includes(s)) throw new ValidationError(`${label}取值不合法`);
  return s;
}

// 表单里可能是单值也可能是数组的字段（开单多行明细）
function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  isEmpty, asString, asInt, asIntOrNull, asDate, asFenOptional, asOneOf, asArray,
};
