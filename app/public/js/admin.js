// Trang quản trị: tổng quan, quản lý đặt phòng, quản lý phòng
const view = $('#view');
const ROOM_TYPES = ['Standard', 'Deluxe', 'Suite', 'Family'];

// Hành động hợp lệ theo trạng thái hiện tại (khớp STATUS_TRANSITIONS phía server)
const ACTIONS = {
  pending: [['confirmed', 'Xác nhận', 'primary'], ['cancelled', 'Hủy', 'danger']],
  confirmed: [['checked_in', 'Check-in', 'primary'], ['cancelled', 'Hủy', 'danger']],
  checked_in: [['checked_out', 'Check-out', 'primary']],
};

let tab = 'overview';

async function init() {
  try {
    await api('/api/admin/me');
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin(msg = '') {
  $('#logout').hidden = true;
  view.innerHTML = `
    <section class="panel login-box">
      <h2>Đăng nhập quản trị</h2>
      ${msg ? alertBox('error', msg) : ''}
      <form id="login" class="stack">
        <label>Tên đăng nhập<input name="username" autocomplete="username" required></label>
        <label>Mật khẩu<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Đăng nhập</button>
      </form>
    </section>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      showApp();
    } catch (err) {
      showLogin(err.message);
    }
  });
}

$('#logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

function showApp() {
  $('#logout').hidden = false;
  view.innerHTML = `
    <div class="tabs">
      <button data-tab="overview">Tổng quan</button>
      <button data-tab="bookings">Đặt phòng</button>
      <button data-tab="rooms">Phòng</button>
    </div>
    <div id="msg"></div>
    <div id="tab"></div>`;
  view.querySelector('.tabs').addEventListener('click', (e) => {
    if (e.target.dataset.tab) { tab = e.target.dataset.tab; renderTab(); }
  });
  renderTab();
}

function flash(type, text) { $('#msg').innerHTML = text ? alertBox(type, text) : ''; }

async function renderTab() {
  view.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  flash();
  try {
    if (tab === 'bookings') await bookingsTab();
    else if (tab === 'rooms') await roomsTab();
    else await overviewTab();
  } catch (err) {
    if (err.status === 401) return showLogin('Phiên đăng nhập đã hết hạn');
    flash('error', err.message);
  }
}

// --------------------------------------------------------------- tổng quan
async function overviewTab() {
  const s = await api('/api/admin/stats');
  const occ = s.active_rooms ? Math.round((s.occupied_today / s.active_rooms) * 100) : 0;
  $('#tab').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${s.active_rooms}/${s.total_rooms}</div><div class="l">Phòng đang hoạt động</div></div>
      <div class="stat"><div class="n">${s.occupied_today} (${occ}%)</div><div class="l">Phòng có khách hôm nay</div></div>
      <div class="stat"><div class="n">${s.pending}</div><div class="l">Đặt phòng chờ xác nhận</div></div>
      <div class="stat"><div class="n">${s.arrivals_today}</div><div class="l">Khách đến hôm nay</div></div>
      <div class="stat"><div class="n">${s.departures_today}</div><div class="l">Khách trả phòng hôm nay</div></div>
      <div class="stat"><div class="n">${money(s.revenue)}</div><div class="l">Doanh thu dự kiến</div></div>
    </div>
    <section class="panel">
      <h3>Đặt phòng theo trạng thái (tổng ${s.total_bookings})</h3>
      <p>${Object.keys(STATUS).map((k) => `${badge(k)} <b>${s.by_status[k] || 0}</b>`).join(' &nbsp; ')}</p>
    </section>`;
}

// ------------------------------------------------------------- đặt phòng
let bookingFilter = { status: '', q: '' };

async function bookingsTab() {
  const q = new URLSearchParams(Object.entries(bookingFilter).filter(([, val]) => val));
  const rows = await api(`/api/admin/bookings?${q}`);
  $('#tab').innerHTML = `
    <section class="panel">
      <form id="bfilter" class="form-row">
        <label>Trạng thái<select name="status"><option value="">Tất cả</option>
          ${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${k === bookingFilter.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>Tìm kiếm<input name="q" value="${esc(bookingFilter.q)}" placeholder="Mã, tên khách, email, số phòng"></label>
        <button class="btn primary" type="submit">Lọc</button>
      </form>
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Mã</th><th>Khách</th><th>Phòng</th><th>Nhận → Trả</th><th>Khách</th><th>Tổng tiền</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>${rows.length ? rows.map((b) => `
          <tr>
            <td><b>${esc(b.booking_code)}</b><div class="meta">${fmtDateTime(b.created_at)}</div></td>
            <td>${esc(b.guest_name)}<div class="meta">${esc(b.guest_email)}<br>${esc(b.guest_phone)}</div>
              ${b.note ? `<div class="meta">📝 ${esc(b.note)}</div>` : ''}</td>
            <td>${esc(b.room_name)}<div class="meta">${esc(b.room_type)}</div></td>
            <td>${fmtDate(b.check_in)} → ${fmtDate(b.check_out)}</td>
            <td>${b.guests}</td>
            <td>${money(b.total_price)}</td>
            <td>${badge(b.status)}</td>
            <td><div class="actions">${(ACTIONS[b.status] || []).map(([st, label, cls]) =>
              `<button class="btn small ${cls}" data-id="${b.id}" data-status="${st}">${label}</button>`).join('') || '<span class="muted">—</span>'}</div></td>
          </tr>`).join('') : '<tr><td colspan="8" class="empty">Không có đặt phòng</td></tr>'}
        </tbody>
      </table>
    </section>`;

  $('#bfilter').addEventListener('submit', (e) => {
    e.preventDefault();
    bookingFilter = { status: e.target.status.value, q: e.target.q.value.trim() };
    renderTab();
  });
  $('#tab tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/admin/bookings/${btn.dataset.id}`, { method: 'PATCH', body: { status: btn.dataset.status } });
      await bookingsTab();
      flash('success', `Đã cập nhật ${r.booking_code} → ${STATUS[r.status][0]}`);
    } catch (err) {
      flash('error', err.message);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ phòng
async function roomsTab() {
  const rooms = await api('/api/admin/rooms');
  $('#tab').innerHTML = `
    <section class="panel" id="room-form-panel"></section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Phòng</th><th>Loại</th><th>Giá/đêm</th><th>Sức chứa</th><th>Giường</th><th>Diện tích</th><th>Trạng thái</th><th>Đặt sắp tới</th><th>Thao tác</th></tr></thead>
        <tbody>${rooms.map((r) => `
          <tr>
            <td><b>${esc(r.name)}</b><div class="meta">Tầng ${r.floor}</div></td>
            <td>${esc(r.type)}</td><td>${money(r.price)}</td><td>${r.capacity}</td>
            <td>${esc(r.beds)}</td><td>${r.area_m2} m²</td>
            <td>${badge(r.status, ROOM_STATUS)}</td><td>${r.upcoming_bookings}</td>
            <td><div class="actions">
              <button class="btn small ghost" data-edit="${r.id}">Sửa</button>
              <button class="btn small danger" data-del="${r.id}">Xóa</button>
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
  roomForm();

  $('#tab tbody').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      roomForm(rooms.find((r) => String(r.id) === edit.dataset.edit));
      window.scrollTo(0, 0);
    } else if (del) {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Xác nhận xóa?'; return; }
      try {
        await api(`/api/admin/rooms/${del.dataset.del}`, { method: 'DELETE' });
        await roomsTab();
        flash('success', 'Đã xóa phòng');
      } catch (err) {
        flash('error', err.message);
      }
    }
  });
}

function roomForm(r) {
  const val = (k, d = '') => esc(r ? r[k] : d);
  $('#room-form-panel').innerHTML = `
    <h3>${r ? `Sửa phòng ${esc(r.name)}` : 'Thêm phòng mới'}</h3>
    <form id="room-form" class="stack">
      <div class="form-row">
        <label>Số phòng<input name="name" value="${val('name')}" required maxlength="10"></label>
        <label>Loại<select name="type">${ROOM_TYPES.map((t) => `<option ${r && r.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Giá/đêm (VND)<input type="number" name="price" value="${val('price', 500000)}" min="10000" step="10000" required></label>
        <label>Sức chứa<input type="number" name="capacity" value="${val('capacity', 2)}" min="1" max="10" required></label>
      </div>
      <div class="form-row">
        <label>Giường<input name="beds" value="${val('beds', '1 giường đôi')}" required maxlength="50"></label>
        <label>Diện tích (m²)<input type="number" name="area_m2" value="${val('area_m2', 20)}" min="5" max="500" required></label>
        <label>Tầng<input type="number" name="floor" value="${val('floor', 1)}" min="0" max="100" required></label>
        <label>Trạng thái<select name="status">${Object.entries(ROOM_STATUS).map(([k, [l]]) =>
          `<option value="${k}" ${(r ? r.status : 'active') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label>Tiện nghi (phân cách bằng dấu phẩy)<input name="amenities" value="${esc(r ? r.amenities.join(', ') : 'Wi-Fi miễn phí, Điều hòa')}"></label>
      <label>Mô tả<textarea name="description" maxlength="1000">${val('description')}</textarea></label>
      <div>
        <button class="btn primary" type="submit">${r ? 'Lưu thay đổi' : 'Thêm phòng'}</button>
        ${r ? '<button class="btn ghost" type="button" id="cancel-edit">Hủy sửa</button>' : ''}
      </div>
    </form>`;
  if (r) $('#cancel-edit').addEventListener('click', () => roomForm());
  $('#room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    for (const k of ['price', 'capacity', 'area_m2', 'floor']) f[k] = Number(f[k]);
    f.amenities = f.amenities.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      if (r) await api(`/api/admin/rooms/${r.id}`, { method: 'PUT', body: f });
      else await api('/api/admin/rooms', { method: 'POST', body: f });
      await roomsTab();
      flash('success', r ? 'Đã cập nhật phòng' : 'Đã thêm phòng');
    } catch (err) {
      flash('error', err.message);
    }
  });
}

init();
