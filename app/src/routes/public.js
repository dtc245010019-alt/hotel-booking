const express = require('express');
const pool = require('../db');
const log = require('../logger');
const v = require('../validate');
const { bookingsCreated, bookingConflicts, bookingStatusChanges } = require('../metrics');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ROOM_COLUMNS = `r.id, r.name, r.type, r.price, r.capacity, r.beds, r.area_m2, r.floor,
  r.description, r.amenities, r.status`;
const ACTIVE = v.ACTIVE_BOOKING_STATUSES;

// Danh sách loại phòng (cho bộ lọc)
router.get('/room-types', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT type, count(*) AS rooms, min(price) AS min_price, max(capacity) AS max_capacity
       FROM rooms WHERE status = 'active' GROUP BY type ORDER BY min(price)`);
  res.json(rows);
}));

// Tìm phòng: lọc theo số khách, loại phòng; nếu có ngày thì chỉ trả về phòng còn trống
router.get('/rooms', ah(async (req, res) => {
  const { check_in: ci, check_out: co, guests, type } = req.query;
  let nights = null;
  if (ci || co) nights = v.stay(ci, co);
  const g = guests ? v.int(guests, 'Số khách', 1, 10) : null;
  const t = type ? v.oneOf(type, 'Loại phòng', v.ROOM_TYPES) : null;

  const { rows } = await pool.query(
    `SELECT ${ROOM_COLUMNS} FROM rooms r
      WHERE r.status = 'active'
        AND ($1::int IS NULL OR r.capacity >= $1)
        AND ($2::text IS NULL OR r.type = $2)
        AND ($3::date IS NULL OR NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.room_id = r.id AND b.status = ANY($5)
                 AND daterange(b.check_in, b.check_out, '[)') && daterange($3::date, $4::date, '[)')))
      ORDER BY r.price, r.name`,
    [g, t, ci || null, co || null, ACTIVE]);

  res.json({
    nights,
    rooms: rows.map((r) => (nights ? { ...r, total_price: r.price * nights } : r)),
  });
}));

// Chi tiết phòng + các khoảng ngày đã có người đặt (không kèm thông tin khách)
router.get('/rooms/:id', ah(async (req, res) => {
  const id = v.int(req.params.id, 'Mã phòng', 1, 2147483647);
  const room = await pool.query(`SELECT ${ROOM_COLUMNS} FROM rooms r WHERE r.id = $1 AND r.status <> 'inactive'`, [id]);
  if (!room.rowCount) return res.status(404).json({ error: 'Không tìm thấy phòng' });
  const booked = await pool.query(
    `SELECT check_in, check_out FROM bookings
      WHERE room_id = $1 AND status = ANY($2) AND check_out > CURRENT_DATE
      ORDER BY check_in LIMIT 50`, [id, ACTIVE]);
  res.json({ ...room.rows[0], booked: booked.rows });
}));

// Tạo đặt phòng. Việc chống trùng lịch do ràng buộc EXCLUDE bookings_no_overlap
// trong PostgreSQL đảm nhận, nên an toàn cả khi nhiều request đến đồng thời.
router.post('/bookings', ah(async (req, res) => {
  const b = req.body || {};
  const roomId = v.int(b.room_id, 'Phòng', 1, 2147483647);
  const name = v.str(b.guest_name, 'Họ tên', 2, 100);
  const email = v.str(b.guest_email, 'Email', 5, 120, v.EMAIL_RE).toLowerCase();
  const phone = v.str(b.guest_phone, 'Số điện thoại', 8, 20, v.PHONE_RE);
  const guests = v.int(b.guests, 'Số khách', 1, 10);
  const note = v.str(b.note, 'Ghi chú', 0, 500);
  v.stay(b.check_in, b.check_out);

  let result;
  try {
    result = await pool.query(
      `INSERT INTO bookings (room_id, guest_name, guest_email, guest_phone, guests,
                             check_in, check_out, total_price, note, status)
       SELECT r.id, $2, $3, $4, $5, $6::date, $7::date, r.price * ($7::date - $6::date), $8, 'pending'
         FROM rooms r WHERE r.id = $1 AND r.status = 'active' AND r.capacity >= $5
       RETURNING id, booking_code, room_id, guest_name, guests, check_in, check_out, total_price, status`,
      [roomId, name, email, phone, guests, b.check_in, b.check_out, note]);
  } catch (err) {
    if (err.code === '23P01') { // exclusion_violation
      bookingConflicts.inc();
      log.warn('booking conflict', { room_id: roomId, check_in: b.check_in, check_out: b.check_out });
      return res.status(409).json({ error: 'Phòng đã có người đặt trong khoảng thời gian này' });
    }
    throw err;
  }

  if (!result.rowCount) {
    const room = await pool.query('SELECT status, capacity FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) return res.status(404).json({ error: 'Không tìm thấy phòng' });
    if (room.rows[0].status !== 'active') return res.status(409).json({ error: 'Phòng đang tạm ngừng nhận khách' });
    return res.status(400).json({ error: `Phòng chỉ chứa tối đa ${room.rows[0].capacity} khách` });
  }

  const booking = result.rows[0];
  bookingsCreated.inc();
  log.info('booking created', { booking_id: booking.id, booking_code: booking.booking_code, room_id: roomId });
  res.status(201).json(booking);
}));

// Khách tra cứu đặt phòng bằng mã + email
router.get('/bookings/lookup', ah(async (req, res) => {
  const code = v.str(req.query.code, 'Mã đặt phòng', 4, 12).toUpperCase();
  const email = v.str(req.query.email, 'Email', 5, 120).toLowerCase();
  const { rows } = await pool.query(
    `SELECT b.id, b.booking_code, b.guest_name, b.guest_email, b.guest_phone, b.guests,
            b.check_in, b.check_out, b.total_price, b.status, b.note, b.created_at,
            r.name AS room_name, r.type AS room_type
       FROM bookings b JOIN rooms r ON r.id = b.room_id
      WHERE b.booking_code = $1 AND b.guest_email = $2`, [code, email]);
  if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy đặt phòng với mã và email này' });
  res.json(rows[0]);
}));

// Khách tự hủy (chỉ khi chưa nhận phòng)
router.post('/bookings/:code/cancel', ah(async (req, res) => {
  const code = v.str(req.params.code, 'Mã đặt phòng', 4, 12).toUpperCase();
  const email = v.str((req.body || {}).email, 'Email', 5, 120).toLowerCase();
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled', updated_at = now()
      WHERE booking_code = $1 AND guest_email = $2
        AND status IN ('pending', 'confirmed') AND check_in >= CURRENT_DATE
      RETURNING id, booking_code, status`, [code, email]);
  if (!rows.length) return res.status(409).json({ error: 'Không thể hủy đặt phòng này' });
  bookingStatusChanges.inc({ status: 'cancelled' });
  log.info('booking cancelled by guest', { booking_id: rows[0].id, booking_code: code });
  res.json(rows[0]);
}));

module.exports = router;
