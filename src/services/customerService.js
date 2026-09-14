const customerModel = require('../models/customerModel');
const orderModel = require('../models/orderModel');
const depositModel = require('../models/depositModel');
const { BusinessError } = require('./errors');

// 客户报电话查自己的历史订单和桶数
const customerService = {
  queryByPhone(phone) {
    if (!phone || !String(phone).trim()) throw new BusinessError('请输入电话');
    const customers = customerModel.findByPhone(String(phone).trim());
    if (customers.length === 0) return { phone, customers: [] };
    return {
      phone,
      customers: customers.map((c) => {
        const orders = orderModel.listByCustomer(c.id);
        const totals = orderModel.customerTotals(c.id);
        const balance = depositModel.getBalance(c.id);
        return { ...c, orders, totals, depositBalance: balance };
      }),
    };
  },

  customerDetail(customerId) {
    const c = customerModel.getById(customerId);
    if (!c) throw new BusinessError('客户不存在');
    return {
      customer: c,
      orders: orderModel.listByCustomer(c.id),
      totals: orderModel.customerTotals(c.id),
      deposit: {
        balance: depositModel.getBalance(c.id),
        ledger: depositModel.listByCustomer(c.id),
      },
    };
  },
};

module.exports = customerService;
