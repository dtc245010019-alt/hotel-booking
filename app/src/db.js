const { Pool, types } = require('pg');
const log = require('./logger');

// DATE -> giữ nguyên chuỗi 'YYYY-MM-DD' (tránh lệch múi giờ khi chuyển sang Date)
types.setTypeParser(1082, (v) => v);
// BIGINT (count(*), sum) -> number; giá trị trong hệ thống nhỏ hơn 2^53
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});

pool.on('error', (err) => log.error('postgres pool error', { error: err.message }));

module.exports = pool;
