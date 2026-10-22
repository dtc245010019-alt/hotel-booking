const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const MAX_NIGHTS = 30;
const MAX_ADVANCE_DAYS = 365;

const ROOM_TYPES = ['Standard', 'Deluxe', 'Suite', 'Family'];
const ROOM_STATUSES = ['active', 'maintenance', 'inactive'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
// Trạng thái còn giữ phòng (khớp với ràng buộc bookings_no_overlap trong DB)
const ACTIVE_BOOKING_STATUSES = ['pending', 'confirmed', 'checked_in'];

// Chuyển trạng thái hợp lệ: đích -> các trạng thái nguồn được phép
const STATUS_TRANSITIONS = {
  confirmed: ['pending'],
  checked_in: ['confirmed'],
  checked_out: ['checked_in'],
  cancelled: ['pending', 'confirmed'],
};

class ValidationError extends Error {}

// Ngày hôm nay theo múi giờ khách sạn, dạng YYYY-MM-DD
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function toMs(s) {
  return Date.parse(`${s}T00:00:00Z`);
}

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const ms = toMs(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

// Kiểm tra khoảng lưu trú; trả về số đêm
function stay(checkIn, checkOut) {
  if (!isDate(checkIn) || !isDate(checkOut)) {
    throw new ValidationError('Ngày nhận/trả phòng không hợp lệ (định dạng YYYY-MM-DD)');
  }
  const nights = Math.round((toMs(checkOut) - toMs(checkIn)) / DAY_MS);
  if (nights <= 0) throw new ValidationError('Ngày trả phòng phải sau ngày nhận phòng');
  if (nights > MAX_NIGHTS) throw new ValidationError(`Chỉ được đặt tối đa ${MAX_NIGHTS} đêm`);
  const t = today();
  if (checkIn < t) throw new ValidationError('Ngày nhận phòng không được ở quá khứ');
  if ((toMs(checkIn) - toMs(t)) / DAY_MS > MAX_ADVANCE_DAYS) {
    throw new ValidationError(`Chỉ nhận đặt trước tối đa ${MAX_ADVANCE_DAYS} ngày`);
  }
  return nights;
}

function int(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${name} phải là số nguyên từ ${min} đến ${max}`);
  }
  return n;
}

function str(v, name, min, max, re) {
  if (typeof v !== 'string') v = v == null ? '' : String(v);
  v = v.trim();
  if (v.length < min || v.length > max) {
    throw new ValidationError(min > 0 ? `${name} phải dài từ ${min} đến ${max} ký tự` : `${name} tối đa ${max} ký tự`);
  }
  if (re && v && !re.test(v)) throw new ValidationError(`${name} không hợp lệ`);
  return v;
}

function oneOf(v, name, list) {
  if (!list.includes(v)) throw new ValidationError(`${name} phải là một trong: ${list.join(', ')}`);
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+ .-]{8,20}$/;
const ROOM_NAME_RE = /^[A-Za-z0-9-]+$/;

module.exports = {
  ValidationError, today, isDate, stay, int, str, oneOf,
  EMAIL_RE, PHONE_RE, ROOM_NAME_RE,
  ROOM_TYPES, ROOM_STATUSES, BOOKING_STATUSES, ACTIVE_BOOKING_STATUSES, STATUS_TRANSITIONS,
};
