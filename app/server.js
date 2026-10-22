const express = require('express');
const path = require('path');
const pool = require('./src/db');
const log = require('./src/logger');
const auth = require('./src/auth');
const { register, httpDuration } = require('./src/metrics');
const { ValidationError } = require('./src/validate');

const problems = auth.checkConfig();
if (problems.length) {
  problems.forEach((p) => log.error('invalid configuration', { problem: p }));
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Tin header X-Forwarded-* từ Nginx (nằm trong mạng Docker nội bộ)
app.set('trust proxy', 'uniquelocal');

// Đo thời gian và ghi access log cho mọi request (trừ healthcheck/metrics)
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path
      : res.statusCode === 404 ? 'not_found'
        : req.path.startsWith('/api') ? '/api/other' : 'static';
    end({ method: req.method, route, status_code: res.statusCode });
    if (req.path === '/metrics' || req.path === '/healthz') return;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]('http request', {
      method: req.method, path: req.path, route, status: res.statusCode,
      duration_ms: Number(process.hrtime.bigint() - start) / 1e6, ip: req.ip,
    });
  });
  next();
});

// /metrics chỉ dành cho Prometheus trong mạng monitoring; Nginx chặn đường này từ bên ngoài
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    log.error('healthcheck failed', { error: err.message });
    res.status(503).json({ status: 'error' });
  }
});

app.use(express.json({ limit: '20kb' }));
app.use('/api', auth.sameOrigin);
app.use('/api', require('./src/routes/public'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Xử lý lỗi tập trung
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON không hợp lệ' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn' });
  log.error('unhandled error', { error: err.message, code: err.code, path: req.path });
  res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại sau' });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => log.info('server started', { port }));

function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err) }));
