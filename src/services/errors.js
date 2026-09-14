class BusinessError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'BusinessError';
    this.code = code || 'BUSINESS_ERROR';
    this.status = status || 409;
  }
}

// 入参格式不对（缺字段、类型错、不是数字等）：400，调用方改参数就能重试
class ValidationError extends BusinessError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

// 资源不存在（订单/客户 ID 在库里查不到）：404
class NotFoundError extends BusinessError {
  constructor(message) {
    super(message || '资源不存在', 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

// 同一单重复回执
class DuplicateReceiptError extends BusinessError {
  constructor(existingReceipt) {
    super('该订单已录过回执，重复提交未改动任何数据', 'DUPLICATE_RECEIPT');
    this.existingReceipt = existingReceipt;
  }
}

module.exports = { BusinessError, ValidationError, NotFoundError, DuplicateReceiptError };
