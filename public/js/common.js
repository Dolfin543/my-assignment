// Helpers shared by every page.

// Calls the API and returns the JSON body. Throws an Error with the server's message on failure.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const page = location.pathname.split('/').pop();
    if (res.status === 401 && !['', 'index.html'].includes(page)) { // logged out (or the session expired): back to the login screen
      location.href = '/';
      return new Promise(() => {});
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const param = (name) => new URLSearchParams(location.search).get(name);
const isStaff = (user) => user.role === 'office_admin' || user.role === 'system_admin';
const homeFor = (user) => (user.mustChangePassword ? '/profile.html' : '/dashboard.html');
const ROLE_LABEL = { member: 'Member', office_admin: 'Office admin', system_admin: 'System admin' };
const OFFICE_TYPE = { mall: 'Shopping mall', police: 'Police station', airport: 'Airport' };
const OFFICE_ICON = { mall: '🛍️', police: '🚓', airport: '✈️' };

// Makes sure someone is logged in (optionally with one of the given roles) and draws the top bar.
async function requireUser(...roles) {
  let user;
  try {
    user = await api('/api/auth/me');
  } catch {
    location.href = '/';
    return new Promise(() => {});
  }
  if (user.mustChangePassword && !location.pathname.endsWith('/profile.html')) {
    location.href = '/profile.html';
    return new Promise(() => {});
  }
  if (roles.length && !roles.includes(user.role)) {
    location.href = homeFor(user);
    return new Promise(() => {});
  }
  renderHeader(user);
  return user;
}

const LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 6h20l12 12v22a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" fill="#e0a458"/><circle cx="31" cy="15" r="3.6" fill="#1f2a44"/><path d="M31 15C38 6 44 8 44 2" stroke="#fffaf2" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="20" cy="27" r="7" fill="none" stroke="#1f2a44" stroke-width="3.2"/><path d="M25 32l6 6" stroke="#1f2a44" stroke-width="3.6" stroke-linecap="round"/></svg>';

function navLinks(user) {
  if (user.role === 'member') {
    return [['dashboard.html', '🏠', 'My items'], ['browse.html', '🔎', 'Found items'], ['report.html?type=lost', '📣', 'Report lost'],
      ['report.html?type=found', '🙌', 'Report found'], ['claims.html', '📝', 'My claims'], ['offices.html', '📍', 'Offices']];
  }
  const links = [['dashboard.html', '🏠', 'Dashboard'], ['browse.html', '🔎', 'Browse'], ['report.html?type=found', '📥', 'Log found item'],
    ['matches.html', '🔗', 'Matches'], ['claims.html', '📝', 'Claims'], ['offices.html', '📍', user.role === 'office_admin' ? 'My office' : 'Offices'],
    ['reports.html', '📊', 'Reports']];
  if (user.role === 'system_admin') links.push(['admin.html', '⚙️', 'Admin']);
  return links;
}

const initials = (user) => `${(user.firstName || '?')[0]}${(user.lastName || '')[0] || ''}`.toUpperCase();

function renderHeader(user) {
  const header = document.querySelector('header');
  header.className = 'topbar';
  const page = location.pathname.split('/').pop();
  const here = page + location.search;
  const links = user.mustChangePassword ? '' : navLinks(user).map(([href, ico, label]) => {
    const active = href.includes('?') ? here.startsWith(href) : page === href;
    return `<a href="${href}" class="${active ? 'active' : ''}"><span class="ico">${ico}</span>${label}</a>`;
  }).join('');
  header.innerHTML = `
    <div class="inner">
      <a class="brand" href="${homeFor(user)}"><span class="logo">${LOGO}</span><strong>Lost &amp; Found</strong></a>
      ${user.mustChangePassword ? '<span style="flex:1"></span>' : `<form class="search" action="browse.html">
        <input type="search" name="q" placeholder="Search wallets, phones, keys, F-000012…" aria-label="Search items" value="${esc(param('q') || '')}">
        <button type="submit">Search</button></form>`}
      <div class="user">
        <a class="me" href="profile.html"><span class="avatar">${esc(initials(user))}</span>
          <span class="who-text">${esc(user.fullName)}<span class="role">${esc(user.role === 'office_admin' && user.officeName ? user.officeName : ROLE_LABEL[user.role])}</span></span></a>
        <button class="ghost" id="logout">Log out</button>
      </div>
    </div>`;
  if (links) header.insertAdjacentHTML('afterend', `<nav class="menu"><div class="inner">${links}</div></nav>`);
  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  };
}

// ---------------------------------------------------------------- labels
const CATEGORY_ICON = {
  'Wallets and purses': '👛', Phones: '📱', Keys: '🔑', Bags: '👜', 'ID and documents': '🪪', 'Bank cards': '💳',
  'Jewellery and watches': '💍', Electronics: '💻', Clothing: '🧥', Glasses: '👓', Other: '📦',
};
const catIcon = (name) => CATEGORY_ICON[name] || '📦';

// Status of an item, in words that make sense for lost and for found items.
function itemStatus(item) {
  const lost = item.item_type === 'lost';
  if (item.status === 'open') {
    if (lost) return ['s-open', 'Still missing'];
    return item.received_at ? ['s-open', 'Waiting at the office'] : ['s-waiting', 'Not handed in yet'];
  }
  return {
    matched: ['s-matched', lost ? 'Possible match found' : 'Matched to a lost report'],
    claimed: ['s-claimed', lost ? 'Claim approved – collect it' : 'Claimed – awaiting collection'],
    returned: ['s-returned', 'Returned to owner'],
    closed: ['s-closed', 'Closed'],
  }[item.status] || ['', item.status];
}
const statusPill = (item) => { const [cls, label] = itemStatus(item); return `<span class="pill ${cls}">${esc(label)}</span>`; };
const kindPill = (type) => `<span class="pill ${type}">${type === 'lost' ? 'Lost' : 'Found'}</span>`;
const claimPill = (code, name) => `<span class="pill c-${esc(code)}">${esc(name)}</span>`;
const matchPill = (s) => `<span class="pill m-${esc(s)}">${{ suggested: 'Suggested', confirmed: 'Confirmed', rejected: 'Rejected' }[s] || esc(s)}</span>`;

// A luggage-tag card for the board.
function tagCard(item) {
  const photo = item.photo_id
    ? `<img src="/api/items/${item.id}/photos/${item.photo_id}" alt="" loading="lazy">`
    : `<span class="cat-ico">${catIcon(item.category)}</span>`;
  const where = item.item_type === 'found' && item.office_name ? `${OFFICE_ICON[item.office_type] || '📍'} ${esc(item.office_name)}` : `📍 ${esc(item.place_detail ? `${item.place_detail}, ` : '')}${esc(item.city)}`;
  return `<a class="tag-card ${item.item_type}" href="item.html?id=${item.id}">
    <div class="tag-top"><span class="tag-kind">${item.item_type}</span><span class="tag-ref">${esc(item.ref)}</span></div>
    <div class="tag-photo">${photo}</div>
    <h3>${esc(item.item_name)}</h3>
    <p class="tag-meta">${where}</p>
    <p class="tag-meta">📅 ${item.item_type === 'lost' ? 'Lost' : 'Found'} ${formatDay(item.event_date)} · ${esc(item.city)}</p>
    ${statusPill(item)}
  </a>`;
}

// ---------------------------------------------------------------- dates
function formatDate(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
function formatDay(value, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}
const pad = (n) => String(n).padStart(2, '0');
function todayInput(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function timeAgo(value) {
  const seconds = Math.round((Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return 'just now';
  for (const [name, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}
const num = (n) => Number(n || 0).toLocaleString();

// ---------------------------------------------------------------- forms
function optionsHtml(items, selectedId, placeholder, label = (i) => i.name) {
  return (placeholder !== undefined && placeholder !== null ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map((i) => `<option value="${i.id}" ${Number(selectedId) === i.id ? 'selected' : ''}>${esc(label(i))}</option>`).join('');
}

// Province -> city pickers. Returns { set(cityId), cities, provinces }.
async function cityPicker(provinceSelect, citySelect, { placeholderAll = null, cityId = null, onChange } = {}) {
  const [provinces, cities] = await Promise.all([api('/api/provinces'), api('/api/cities')]);
  const fillCities = (selected) => {
    const pId = Number(provinceSelect.value);
    const list = cities.filter((c) => !pId || c.province_id === pId);
    citySelect.innerHTML = optionsHtml(list, selected, placeholderAll ?? 'Choose a city…', (c) => (pId ? c.name : `${c.name} (${c.province})`));
  };
  provinceSelect.innerHTML = optionsHtml(provinces, null, placeholderAll ?? 'Choose a province…');
  provinceSelect.onchange = () => { fillCities(null); if (onChange) onChange(); };
  citySelect.addEventListener('change', () => { if (onChange) onChange(); });
  const set = (id) => {
    const c = cities.find((x) => x.id === Number(id));
    provinceSelect.value = c ? c.province_id : '';
    fillCities(c ? c.id : null);
  };
  set(cityId);
  return { set, cities, provinces };
}

function tempPasswordNotice(name, username, password) {
  return `<div class="success">
    <strong>Login details for ${esc(name)}:</strong><br>
    Username: <strong>${esc(username)}</strong><br>
    Temporary password: <span class="temp-password">${esc(password)}</span><br>
    <span class="small">They choose their own password when they first log in. This password won't be shown again.</span>
  </div>`;
}

function flash(message) {
  const el = document.getElementById('banner');
  el.innerHTML = `<div class="success">${esc(message)}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// Reads chosen image files as { name, type, data(base64), preview } for the API.
function readImageFiles(files) {
  return Promise.all([...files].map((f) => new Promise((resolve, reject) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) return reject(new Error(`${f.name} is not a JPEG, PNG or WebP image.`));
    if (f.size > 2 * 1024 * 1024) return reject(new Error(`${f.name} is larger than 2 MB.`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: f.name, type: f.type, data: reader.result, preview: reader.result, isPublic: true });
    reader.onerror = () => reject(new Error(`Could not read ${f.name}.`));
    reader.readAsDataURL(f);
  })));
}

function lightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${esc(src)}" alt="">`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}

// Horizontal bars with a lost and a found part: rows = [{ name, lost, found }]
function lostFoundBars(rows) {
  if (!rows.length) return '<p class="muted">Nothing in this period.</p>';
  const max = Math.max(1, ...rows.map((r) => Number(r.lost || 0) + Number(r.found || 0)));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row"><span title="${esc(r.name)}">${esc(r.name)}</span>
    <div class="bar"><span class="l" style="width:${(100 * (r.lost || 0)) / max}%"></span><span class="f" style="width:${(100 * (r.found || 0)) / max}%"></span></div>
    <span>${num(r.lost)} · ${num(r.found)}</span></div>`).join('')}</div>`;
}
