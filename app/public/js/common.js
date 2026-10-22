// Tiện ích dùng chung cho trang khách và trang quản trị
const $ = (sel, el = document) => el.querySelector(sel);

// Escape mọi dữ liệu trước khi chèn vào HTML để chống XSS
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => `${Number(n).toLocaleString('vi-VN')} ₫`;
const fmtDate = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const fmtDateTime = (s) => new Date(s).toLocaleString('vi-VN');

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const TYPE_ICON = { Standard: '🛏️', Deluxe: '🌆', Suite: '👑', Family: '👨‍👩‍👧' };

const STATUS = {
  pending: ['Chờ xác nhận', 'warn'],
  confirmed: ['Đã xác nhận', 'info'],
  checked_in: ['Đang lưu trú', 'ok'],
  checked_out: ['Đã trả phòng', 'muted'],
  cancelled: ['Đã hủy', 'danger'],
};
const ROOM_STATUS = { active: ['Hoạt động', 'ok'], maintenance: ['Bảo trì', 'warn'], inactive: ['Ngừng sử dụng', 'muted'] };
const badge = (s, map = STATUS) => `<span class="badge ${(map[s] || [])[1] || 'muted'}">${esc((map[s] || [s])[0])}</span>`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* không có body JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Lỗi ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const alertBox = (type, msg) => `<div class="alert ${type}">${esc(msg)}</div>`;
