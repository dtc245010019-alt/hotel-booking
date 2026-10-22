const express = require('express');
const pool = require('../db');
const log = require('../logger');
const v = require('../validate');
const auth = require('../auth');
const { bookingStatusChanges } = require('../metrics');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/login', auth.login);
router.post('/logout', auth.logout);

// Mọi route bên dưới yêu cầu đăng nhập
router.use(auth.requireAdmin);

router.get('/me', (req, res) => res.json({ user: req.admin }));

router.get('/stats', ah(async (req, res) => {
  const { rows: [s] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM rooms WHERE status = 'active') AS active_rooms,
      (SELECT count(*) FROM rooms) AS total_rooms,
      (SELECT count(DISTINCT room_id) FROM bookings
        WHERE status IN ('confirmed','checked_in') AND check_in <= CURRENT_DATE AND check_out > CURRENT_DATE) AS occupied_today,
      (SELECT count(*) FROM bookings WHERE status = 'pending') AS pending,
      (SELECT count(*) FROM bookings WHERE check_in = CURRENT_DATE AND status IN ('confirmed','pending')) AS arrivals_today,
      (SELECT count(*) FROM bookings WHERE check_out = CURRENT_DATE AND status = 'checked_in') AS departures_today,
      (SELECT coalesce(sum(total_price), 0) FROM bookings WHERE status <> 'cancelled') AS revenue,
      (SELECT count(*) FROM bookings) AS total_bookings`);
  const { rows: byStatus } = await pool.query('SELECT status, count(*) AS n FROM bookings GROUP BY status');
  res.json({ ...s, by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) });
}));

// ------------------------------------------------------------ bookings
router.get('/bookings', ah(async (req, res) => {
  const status = req.query.status ? v.oneOf(req.query.status, 'Trạng thái', v.BOOKING_STATUSES) : null;
  const q = req.query.q ? v.str(req.query.q, 'Từ khóa', 1, 100) : null;
  const { rows } = await pool.query(
    `SELECT b.id, b.booking_code, b.guest_name, b.guest_email, b.guest_phone, b.guests,
            b.check_in, b.check_out, b.total_price, b.status, b.note, b.created_at, b.updated_at,
            r.name AS room_name, r.type AS room_type
       FROM bookings b JOIN rooms r ON r.id = b.room_id
      WHERE ($1::text IS NULL OR b.status = $1)
        AND ($2::text IS NULL OR b.booking_code ILIKE '%' || $2 || '%' OR b.guest_name ILIKE '%' || $2 || '%'
             OR b.guest_email ILIKE '%' || $2 || '%' OR r.name = $2)
      ORDER BY b.check_in DESC, b.id DESC LIMIT 200`, [status, q]);
  res.json(rows);
}));

router.patch('/bookings/:id', ah(async (req, res) => {
  const id = v.int(req.params.id, 'Mã đặt phòng', 1, 2147483647);
  const status = v.oneOf((req.body || {}).status, 'Trạng thái', Object.keys(v.STATUS_TRANSITIONS));
  const { rows } = await pool.query(
    `UPDATE bookings SET status = $2, updated_at = now()
      WHERE id = $1 AND status = ANY($3) RETURNING id, booking_code, status`,
    [id, status, v.STATUS_TRANSITIONS[status]]);
  if (!rows.length) {
    return res.status(409).json({ error: `Không thể chuyển sang trạng thái "${status}" từ trạng thái hiện tại` });
  }
  bookingStatusChanges.inc({ status });
  log.info('booking status changed', { booking_id: id, status, by: req.admin });
  res.json(rows[0]);
}));

// --------------------------------------------------------------- rooms
router.get('/rooms', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, (SELECT count(*) FROM bookings b
                   WHERE b.room_id = r.id AND b.status = ANY($1) AND b.check_out > CURRENT_DATE) AS upcoming_bookings
       FROM rooms r ORDER BY r.name`, [v.ACTIVE_BOOKING_STATUSES]);
  res.json(rows);
}));

function roomInput(body = {}) {
  const amenities = Array.isArray(body.amenities)
    ? body.amenities
    : String(body.amenities || '').split(',');
  const list = amenities.map((a) => v.str(a, 'Tiện nghi', 0, 50)).filter(Boolean);
  if (list.length > 20) throw new v.ValidationError('Tối đa 20 tiện nghi');
  return [
    v.str(body.name, 'Số phòng', 1, 10, v.ROOM_NAME_RE),
    v.oneOf(body.type, 'Loại phòng', v.ROOM_TYPES),
    v.int(body.price, 'Giá', 10000, 100000000),
    v.int(body.capacity, 'Sức chứa', 1, 10),
    v.str(body.beds, 'Giường', 1, 50),
    v.int(body.area_m2, 'Diện tích', 5, 500),
    v.int(body.floor, 'Tầng', 0, 100),
    v.str(body.description, 'Mô tả', 0, 1000),
    list,
    v.oneOf(body.status || 'active', 'Trạng thái', v.ROOM_STATUSES),
  ];
}

function duplicateName(err, res) {
  if (err.code === '23505') {
    res.status(409).json({ error: 'Số phòng đã tồn tại' });
    return true;
  }
  return false;
}

router.post('/rooms', ah(async (req, res) => {
  const params = roomInput(req.body);
  try {
    const { rows } = await pool.query(
      `INSERT INTO rooms (name, type, price, capacity, beds, area_m2, floor, description, amenities, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, params);
    log.info('room created', { room_id: rows[0].id, by: req.admin });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (!duplicateName(err, res)) throw err;
  }
}));

router.put('/rooms/:id', ah(async (req, res) => {
  const id = v.int(req.params.id, 'Mã phòng', 1, 2147483647);
  const params = roomInput(req.body);
  try {
    const { rows } = await pool.query(
      `UPDATE rooms SET name=$2, type=$3, price=$4, capacity=$5, beds=$6, area_m2=$7, floor=$8,
              description=$9, amenities=$10, status=$11, updated_at=now()
        WHERE id = $1 RETURNING *`, [id, ...params]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy phòng' });
    log.info('room updated', { room_id: id, by: req.admin });
    res.json(rows[0]);
  } catch (err) {
    if (!duplicateName(err, res)) throw err;
  }
}));

router.delete('/rooms/:id', ah(async (req, res) => {
  const id = v.int(req.params.id, 'Mã phòng', 1, 2147483647);
  try {
    const { rowCount } = await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy phòng' });
    log.info('room deleted', { room_id: id, by: req.admin });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') { // foreign_key_violation
      return res.status(409).json({ error: 'Phòng đã có lịch sử đặt phòng, hãy chuyển trạng thái sang "inactive" thay vì xóa' });
    }
    throw err;
  }
}));

module.exports = router;
