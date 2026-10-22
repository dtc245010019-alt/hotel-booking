const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
app.use(express.json());
app.use(express.static('public'));
client.collectDefaultMetrics();

const pool = new Pool({
  host: process.env.DB_HOST, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/api/rooms', async (req, res) => {
  const r = await pool.query('SELECT * FROM rooms ORDER BY id');
  res.json(r.rows);
});

app.get('/api/bookings', async (req, res) => {
  const r = await pool.query(
    'SELECT b.*, r.name AS room FROM bookings b JOIN rooms r ON r.id=b.room_id ORDER BY b.id DESC');
  res.json(r.rows);
});

app.post('/api/bookings', async (req, res) => {
  const { room_id, guest_name, check_in, check_out } = req.body;
  if (!room_id || !guest_name || !check_in || !check_out || check_out <= check_in) {
    log('warn', 'invalid booking request');
    return res.status(400).json({ error: 'Du lieu khong hop le' });
  }
  const dup = await pool.query(
    'SELECT 1 FROM bookings WHERE room_id=$1 AND check_in < $3 AND check_out > $2',
    [room_id, check_in, check_out]);
  if (dup.rowCount) {
    log('warn', 'room already booked', { room_id });
    return res.status(409).json({ error: 'Phong da duoc dat trong khoang nay' });
  }
  const r = await pool.query(
    'INSERT INTO bookings(room_id,guest_name,check_in,check_out) VALUES($1,$2,$3,$4) RETURNING *',
    [room_id, guest_name, check_in, check_out]);
  log('info', 'booking created', { booking_id: r.rows[0].id, guest_name });
  res.status(201).json(r.rows[0]);
});

app.listen(3000, () => log('info', 'server started on 3000'));
