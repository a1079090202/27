const path = require('path');

module.exports = {
  port: process.env.PORT || 3000,
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'water.db'),
};
