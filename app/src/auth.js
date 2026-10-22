// Phiên đăng nhập quản trị: cookie HttpOnly chứa payload được ký HMAC-SHA256.
// Không cần lưu session phía server, nên container app có thể chạy read-only.
const crypto = require('crypto');
const log = require('./logger');
const { adminLogins } = require('./metrics');

const COOKIE = 'hb_admin';
const TTL_SECONDS = 8 * 3600;
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';

function checkConfig() {
  const problems = [];
  if (ADMIN_PASSWORD.length < 12) problems.push('ADMIN_PASSWORD phải có ít nhất 12 ký tự');
  if (SECRET.length < 32) problems.push('SESSION_SECRET phải có ít nhất 32 ký tự');
  return problems;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
// So sánh hằng thời gian (băm trước để hai buffer cùng độ dài)
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setCookie(res, value, maxAge) {
  res.append('Set-Cookie', [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`,
    ...(COOKIE_SECURE ? ['Secure'] : []),
  ].join('; '));
}

// Giới hạn đăng nhập sai: 5 lần / 15 phút / IP
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

function login(req, res) {
  const ip = req.ip;
  if (tooManyFailures(ip)) {
    adminLogins.inc({ result: 'blocked' });
    log.warn('admin login blocked', { ip });
    return res.status(429).json({ error: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' });
  }
  const { username = '', password = '' } = req.body || {};
  // Luôn so sánh cả hai để không lộ thông tin qua thời gian phản hồi
  const ok = safeEqual(username, ADMIN_USER) & safeEqual(password, ADMIN_PASSWORD);
  if (!ok) {
    recordFailure(ip);
    adminLogins.inc({ result: 'failure' });
    log.warn('admin login failed', { ip });
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  failures.delete(ip);
  adminLogins.inc({ result: 'success' });
  log.info('admin login success', { ip, user: ADMIN_USER });
  setCookie(res, sign({ sub: ADMIN_USER, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS }), TTL_SECONDS);
  res.json({ user: ADMIN_USER });
}

function logout(req, res) {
  setCookie(res, '', 0);
  res.json({ ok: true });
}

function requireAdmin(req, res, next) {
  const session = verify(readCookie(req, COOKIE));
  if (!session) return res.status(401).json({ error: 'Cần đăng nhập quản trị' });
  req.admin = session.sub;
  next();
}

// Chặn request thay đổi dữ liệu đến từ origin khác (bổ sung cho SameSite=Strict)
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (req.method === 'GET' || req.method === 'HEAD' || !origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* origin không hợp lệ */ }
  log.warn('cross-origin request rejected', { origin, path: req.path });
  res.status(403).json({ error: 'Origin không hợp lệ' });
}

module.exports = { checkConfig, login, logout, requireAdmin, sameOrigin };
