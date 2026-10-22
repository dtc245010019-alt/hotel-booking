// Trang khách: tìm phòng, xem chi tiết, đặt phòng, tra cứu/hủy đặt phòng.
// Router đơn giản theo hash: #/  #/room/:id  #/lookup
const view = $('#view');

function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  return { path: path || '/', params: new URLSearchParams(qs || '') };
}

function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

async function route() {
  const { path, params } = parseHash();
  const m = path.match(/^\/room\/(\d+)$/);
  try {
    if (m) { setNav(''); await roomPage(m[1], params); }
    else if (path === '/lookup') { setNav('lookup'); lookupPage(params); }
    else { setNav('search'); await searchPage(params); }
  } catch (err) {
    view.innerHTML = alertBox('error', err.message);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ tìm phòng
let roomTypes = null;

async function searchPage(params) {
  if (!roomTypes) roomTypes = await api('/api/room-types');
  const ci = params.get('check_in') || '';
  const co = params.get('check_out') || '';
  const guests = params.get('guests') || '';
  const type = params.get('type') || '';
  const t = todayISO();

  view.innerHTML = `
    <section class="hero">
      <h1>Tìm phòng phù hợp cho chuyến đi của bạn</h1>
      <p>Chọn ngày nhận phòng, trả phòng và số khách để xem các phòng còn trống.</p>
      <form id="search" class="form-row" novalidate>
        <label>Ngày nhận phòng<input type="date" name="check_in" min="${t}" value="${esc(ci)}"></label>
        <label>Ngày trả phòng<input type="date" name="check_out" min="${addDays(t, 1)}" value="${esc(co)}"></label>
        <label>Số khách<select name="guests">
          <option value="">Bất kỳ</option>
          ${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${String(n) === guests ? 'selected' : ''}>${n} khách</option>`).join('')}
        </select></label>
        <label>Loại phòng<select name="type">
          <option value="">Tất cả</option>
          ${roomTypes.map((rt) => `<option value="${esc(rt.type)}" ${rt.type === type ? 'selected' : ''}>${esc(rt.type)} (từ ${money(rt.min_price)})</option>`).join('')}
        </select></label>
        <button class="btn" type="submit">Tìm phòng</button>
      </form>
      <div id="search-msg"></div>
    </section>
    <div id="results"><p class="muted">Đang tải…</p></div>`;

  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const q = new URLSearchParams();
    const fi = f.get('check_in'); const fo = f.get('check_out');
    if (fi || fo) {
      if (!fi || !fo) return showSearchError('Vui lòng chọn cả ngày nhận và ngày trả phòng');
      if (fo <= fi) return showSearchError('Ngày trả phòng phải sau ngày nhận phòng');
      q.set('check_in', fi); q.set('check_out', fo);
    }
    if (f.get('guests')) q.set('guests', f.get('guests'));
    if (f.get('type')) q.set('type', f.get('type'));
    location.hash = `#/?${q}`;
  });
  // Tự gợi ý ngày trả = ngày nhận + 1
  $('#search [name=check_in]').addEventListener('change', (e) => {
    const out = $('#search [name=check_out]');
    if (e.target.value && (!out.value || out.value <= e.target.value)) out.value = addDays(e.target.value, 1);
  });

  const q = new URLSearchParams();
  for (const k of ['check_in', 'check_out', 'guests', 'type']) if (params.get(k)) q.set(k, params.get(k));
  try {
    const data = await api(`/api/rooms?${q}`);
    renderResults(data, params);
  } catch (err) {
    $('#results').innerHTML = alertBox('error', err.message);
  }
}

function showSearchError(msg) { $('#search-msg').innerHTML = alertBox('error', msg); }

function renderResults({ nights, rooms }, params) {
  const keep = new URLSearchParams();
  for (const k of ['check_in', 'check_out', 'guests']) if (params.get(k)) keep.set(k, params.get(k));
  const title = nights
    ? `${rooms.length} phòng còn trống từ ${fmtDate(params.get('check_in'))} đến ${fmtDate(params.get('check_out'))} (${nights} đêm)`
    : `Tất cả phòng (${rooms.length}) — chọn ngày để xem phòng còn trống`;
  $('#results').innerHTML = `<h2>${esc(title)}</h2>${rooms.length ? `<div class="grid">${rooms.map((r) => `
    <article class="card">
      <div class="room-thumb t-${esc(r.type)}">${TYPE_ICON[r.type] || '🏨'}</div>
      <div class="body">
        <h3 class="room-title">Phòng ${esc(r.name)} · ${esc(r.type)}</h3>
        <div class="meta">👥 Tối đa ${r.capacity} khách · ${esc(r.beds)} · ${r.area_m2} m²</div>
        <ul class="chips">${r.amenities.slice(0, 4).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      </div>
      <div class="foot">
        <div><div class="price">${money(r.price)}<span class="meta"> / đêm</span></div>
          ${r.total_price ? `<div class="meta">Tổng ${nights} đêm: <b>${money(r.total_price)}</b></div>` : ''}</div>
        <a class="btn primary small" href="#/room/${r.id}?${keep}">Chi tiết</a>
      </div>
    </article>`).join('')}</div>` : '<div class="panel empty">Không còn phòng phù hợp. Hãy thử ngày khác hoặc giảm số khách.</div>'}`;
}

// --------------------------------------------------------------- chi tiết phòng
async function roomPage(id, params) {
  const r = await api(`/api/rooms/${id}`);
  const t = todayISO();
  const ci = params.get('check_in') || '';
  const co = params.get('check_out') || '';
  const guests = Math.min(Number(params.get('guests')) || 1, r.capacity);

  view.innerHTML = `
    <p><a href="#/">← Quay lại tìm phòng</a></p>
    <div class="two-col">
      <div class="stack">
        <article class="card">
          <div class="room-thumb t-${esc(r.type)}" style="height:180px">${TYPE_ICON[r.type] || '🏨'}</div>
          <div class="body">
            <h1 class="room-title">Phòng ${esc(r.name)} · ${esc(r.type)} ${r.status !== 'active' ? badge(r.status, ROOM_STATUS) : ''}</h1>
            <p class="price">${money(r.price)} <span class="meta">/ đêm</span></p>
            <p>${esc(r.description)}</p>
            <table>
              <tr><th>Loại phòng</th><td>${esc(r.type)}</td></tr>
              <tr><th>Sức chứa</th><td>Tối đa ${r.capacity} khách</td></tr>
              <tr><th>Giường</th><td>${esc(r.beds)}</td></tr>
              <tr><th>Diện tích</th><td>${r.area_m2} m²</td></tr>
              <tr><th>Tầng</th><td>${r.floor}</td></tr>
            </table>
            <h3>Tiện nghi</h3>
            <ul class="chips">${r.amenities.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
          </div>
        </article>
        <section class="panel">
          <h3>Lịch đã được đặt</h3>
          ${r.booked.length ? `<ul>${r.booked.map((b) => `<li>${fmtDate(b.check_in)} → ${fmtDate(b.check_out)}</li>`).join('')}</ul>
            <p class="meta">Ngày trả phòng của khách trước có thể là ngày nhận phòng của bạn.</p>`
            : '<p class="muted">Chưa có lịch đặt nào sắp tới.</p>'}
        </section>
      </div>
      <section class="panel" id="booking-panel">
        <h2>Đặt phòng</h2>
        ${r.status !== 'active' ? alertBox('info', 'Phòng đang tạm ngừng nhận khách.') : `
        <form id="book" class="stack" novalidate>
          <div class="form-row">
            <label>Nhận phòng<input type="date" name="check_in" min="${t}" value="${esc(ci)}" required></label>
            <label>Trả phòng<input type="date" name="check_out" min="${addDays(t, 1)}" value="${esc(co)}" required></label>
          </div>
          <label>Số khách<select name="guests">
            ${Array.from({ length: r.capacity }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === guests ? 'selected' : ''}>${n} khách</option>`).join('')}
          </select></label>
          <label>Họ và tên<input name="guest_name" maxlength="100" required autocomplete="name"></label>
          <label>Email<input type="email" name="guest_email" maxlength="120" required autocomplete="email"></label>
          <label>Số điện thoại<input type="tel" name="guest_phone" maxlength="20" required autocomplete="tel"></label>
          <label>Ghi chú<textarea name="note" maxlength="500" placeholder="Yêu cầu đặc biệt (không bắt buộc)"></textarea></label>
          <div class="summary" id="summary">Chọn ngày để xem tổng tiền.</div>
          <div id="book-msg"></div>
          <button class="btn primary" type="submit">Xác nhận đặt phòng</button>
          <p class="meta">Không cần thanh toán trực tuyến. Khách sạn sẽ xác nhận đặt phòng của bạn.</p>
        </form>`}
      </section>
    </div>`;

  const form = $('#book');
  if (!form) return;
  const summary = () => {
    const a = form.check_in.value; const b = form.check_out.value;
    if (!a || !b) { $('#summary').textContent = 'Chọn ngày để xem tổng tiền.'; return; }
    const n = nightsBetween(a, b);
    $('#summary').innerHTML = n > 0
      ? `${n} đêm × ${money(r.price)} = <b>${money(n * r.price)}</b>`
      : '<span style="color:var(--danger)">Ngày trả phòng phải sau ngày nhận phòng</span>';
  };
  form.check_in.addEventListener('change', () => {
    if (form.check_in.value && (!form.check_out.value || form.check_out.value <= form.check_in.value)) {
      form.check_out.value = addDays(form.check_in.value, 1);
    }
    summary();
  });
  form.check_out.addEventListener('change', summary);
  summary();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.check_in || !f.check_out) return showBookError('Vui lòng chọn ngày nhận và trả phòng');
    if (f.check_out <= f.check_in) return showBookError('Ngày trả phòng phải sau ngày nhận phòng');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const b = await api('/api/bookings', { method: 'POST', body: { ...f, room_id: r.id, guests: Number(f.guests) } });
      $('#booking-panel').innerHTML = `
        <h2>🎉 Đặt phòng thành công</h2>
        ${alertBox('success', 'Đặt phòng của bạn đang chờ khách sạn xác nhận.')}
        <p>Mã đặt phòng của bạn:</p><p class="code">${esc(b.booking_code)}</p>
        <table>
          <tr><th>Phòng</th><td>${esc(r.name)} · ${esc(r.type)}</td></tr>
          <tr><th>Nhận phòng</th><td>${fmtDate(b.check_in)}</td></tr>
          <tr><th>Trả phòng</th><td>${fmtDate(b.check_out)}</td></tr>
          <tr><th>Số khách</th><td>${b.guests}</td></tr>
          <tr><th>Tổng tiền</th><td><b>${money(b.total_price)}</b></td></tr>
          <tr><th>Trạng thái</th><td>${badge(b.status)}</td></tr>
        </table>
        <p class="meta">Hãy lưu lại mã đặt phòng và email (${esc(f.guest_email)}) để tra cứu hoặc hủy.</p>
        <a class="btn" href="#/lookup?code=${encodeURIComponent(b.booking_code)}">Tra cứu đặt phòng</a>`;
    } catch (err) {
      showBookError(err.message);
      btn.disabled = false;
    }
  });
}

function showBookError(msg) { $('#book-msg').innerHTML = alertBox('error', msg); }

// ------------------------------------------------------------- tra cứu / hủy
function lookupPage(params) {
  view.innerHTML = `
    <section class="panel" style="max-width:640px;margin:auto">
      <h2>Tra cứu đặt phòng</h2>
      <form id="lookup" class="form-row" novalidate>
        <label>Mã đặt phòng<input name="code" value="${esc(params.get('code') || '')}" placeholder="VD: HBDEMO03" required></label>
        <label>Email đặt phòng<input type="email" name="email" required></label>
        <button class="btn primary" type="submit">Tra cứu</button>
      </form>
      <div id="lookup-result"></div>
    </section>`;
  $('#lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    await doLookup(e.target.code.value.trim(), e.target.email.value.trim());
  });
}

async function doLookup(code, email) {
  const out = $('#lookup-result');
  if (!code || !email) { out.innerHTML = alertBox('error', 'Vui lòng nhập mã đặt phòng và email'); return; }
  try {
    const b = await api(`/api/bookings/lookup?${new URLSearchParams({ code, email })}`);
    const cancellable = ['pending', 'confirmed'].includes(b.status) && b.check_in >= todayISO();
    out.innerHTML = `
      <h3>Đặt phòng ${esc(b.booking_code)} ${badge(b.status)}</h3>
      <table>
        <tr><th>Khách</th><td>${esc(b.guest_name)} · ${esc(b.guest_phone)}</td></tr>
        <tr><th>Phòng</th><td>${esc(b.room_name)} · ${esc(b.room_type)}</td></tr>
        <tr><th>Thời gian</th><td>${fmtDate(b.check_in)} → ${fmtDate(b.check_out)} (${nightsBetween(b.check_in, b.check_out)} đêm)</td></tr>
        <tr><th>Số khách</th><td>${b.guests}</td></tr>
        <tr><th>Tổng tiền</th><td><b>${money(b.total_price)}</b></td></tr>
        ${b.note ? `<tr><th>Ghi chú</th><td>${esc(b.note)}</td></tr>` : ''}
        <tr><th>Ngày đặt</th><td>${fmtDateTime(b.created_at)}</td></tr>
      </table>
      ${cancellable ? '<p><button class="btn danger" id="cancel-btn">Hủy đặt phòng</button></p>' : ''}
      <div id="cancel-msg"></div>`;
    const btn = $('#cancel-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Bấm lần nữa để xác nhận hủy'; return; }
        btn.disabled = true;
        try {
          await api(`/api/bookings/${encodeURIComponent(b.booking_code)}/cancel`, { method: 'POST', body: { email } });
          await doLookup(code, email);
          $('#cancel-msg').innerHTML = alertBox('success', 'Đã hủy đặt phòng.');
        } catch (err) {
          $('#cancel-msg').innerHTML = alertBox('error', err.message);
          btn.disabled = false;
        }
      });
    }
  } catch (err) {
    out.innerHTML = alertBox('error', err.message);
  }
}

route();
