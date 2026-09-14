class BusinessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BusinessError';
    this.code = code || 'BUSINESS_ERROR';
  }
}

// 同一单重复回执
class DuplicateReceiptError extends BusinessError {
  constructor(existingReceipt) {
    super('该订单已录过回执，重复提交未改动任何数据', 'DUPLICATE_RECEIPT');
    this.existingReceipt = existingReceipt;
  }
}

module.exports = { BusinessError, DuplicateReceiptError };
