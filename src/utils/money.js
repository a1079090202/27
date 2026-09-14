// 金额：库存「分」，页面显示「元」
function fenToYuan(fen) {
  const n = Math.round(Number(fen || 0));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + (abs / 100).toFixed(2);
}

function yuanToFen(yuan) {
  if (yuan === null || yuan === undefined || yuan === '') return 0;
  const n = Number(yuan);
  if (!Number.isFinite(n)) throw new Error('金额格式不正确: ' + yuan);
  return Math.round(n * 100);
}

module.exports = { fenToYuan, yuanToFen };
