const client = require('prom-client');
const pool = require('./db');
const log = require('./logger');

const register = client.register;
client.collectDefaultMetrics();

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Thời gian xử lý HTTP request',
  // route là pattern của Express (vd /api/rooms/:id), không phải URL thật -> cardinality thấp
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const bookingsCreated = new client.Counter({
  name: 'hotel_bookings_created_total',
  help: 'Số đặt phòng được tạo thành công',
});

const bookingConflicts = new client.Counter({
  name: 'hotel_booking_conflicts_total',
  help: 'Số yêu cầu đặt phòng bị từ chối do trùng lịch',
});

const bookingStatusChanges = new client.Counter({
  name: 'hotel_booking_status_changes_total',
  help: 'Số lần đổi trạng thái đặt phòng',
  labelNames: ['status'],
});

const adminLogins = new client.Counter({
  name: 'hotel_admin_login_total',
  help: 'Số lần đăng nhập trang quản trị',
  labelNames: ['result'],
});

// Các gauge nghiệp vụ được tính tại thời điểm Prometheus scrape
new client.Gauge({
  name: 'hotel_bookings',
  help: 'Số đặt phòng hiện có theo trạng thái',
  labelNames: ['status'],
  async collect() {
    try {
      const { rows } = await pool.query('SELECT status, count(*) AS n FROM bookings GROUP BY status');
      this.reset();
      for (const s of ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled']) this.set({ status: s }, 0);
      for (const r of rows) this.set({ status: r.status }, r.n);
    } catch (err) {
      log.error('metrics query failed', { error: err.message });
    }
  },
});

new client.Gauge({
  name: 'hotel_rooms',
  help: 'Số phòng theo trạng thái',
  labelNames: ['status'],
  async collect() {
    try {
      const { rows } = await pool.query('SELECT status, count(*) AS n FROM rooms GROUP BY status');
      this.reset();
      for (const r of rows) this.set({ status: r.status }, r.n);
    } catch (err) {
      log.error('metrics query failed', { error: err.message });
    }
  },
});

new client.Gauge({
  name: 'hotel_rooms_occupied',
  help: 'Số phòng đang có khách (có đặt phòng hiệu lực bao trùm ngày hôm nay)',
  async collect() {
    try {
      const { rows } = await pool.query(
        `SELECT count(DISTINCT room_id) AS n FROM bookings
          WHERE status IN ('confirmed','checked_in') AND check_in <= CURRENT_DATE AND check_out > CURRENT_DATE`);
      this.set(rows[0].n);
    } catch (err) {
      log.error('metrics query failed', { error: err.message });
    }
  },
});

new client.Gauge({
  name: 'hotel_db_pool_connections',
  help: 'Kết nối trong connection pool PostgreSQL của ứng dụng',
  labelNames: ['state'],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

module.exports = { register, httpDuration, bookingsCreated, bookingConflicts, bookingStatusChanges, adminLogins };
