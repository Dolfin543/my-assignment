// Concurrency and performance tests (non-functional requirements: performance, reliability and
// data accuracy when many people use the system at the same time, e.g. after a busy weekend at a mall).
// Self-contained: creates its own office, staff and members, and removes all of it.
// Needs the app running (npm start).
// Usage: node tools/test-load.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3005}`;
const tag = Date.now().toString(36).slice(-6);
const PASSWORD = 'Test-pass-123';
const MEMBERS = 30;
const STAFF = 3;
const like = `%.${tag}@loadtest.test`;

class Client {
  constructor() { this.cookie = ''; }
  async call(url, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }
}

const results = [];
function check(area, name, pass, detail = '') {
  results.push({ area, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const pct = (list, p) => list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))];
async function timed(fn) { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, r }; }
const day = (offset = 0) => new Date(Date.now() + offset * 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const count = (list, status) => list.filter((x) => x.status === status).length;

let officeId = null;
let officeAddress = null;
async function makePeople(prefix, n, role, hash) {
  const clients = [];
  for (let i = 0; i < n; i++) {
    const username = `${prefix}${i}.${tag}`;
    const [p] = await pool.query('INSERT INTO persons (first_name, last_name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [`Load${prefix}`, `Person${i}`, username, `${username}@loadtest.test`, hash, role]);
    if (role === 'office_admin') await pool.query('INSERT INTO it_admins (lfo_id, person_id) VALUES (?, ?)', [officeId, p.insertId]);
    const c = new Client();
    await c.call('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
    clients.push(c);
  }
  return clients;
}

async function main() {
  // Setup straight in the database (fast).
  const [[{ id: cityId }]] = await pool.query("SELECT id FROM cities WHERE name = 'Mthatha'");
  const [[{ id: phones }]] = await pool.query("SELECT id FROM item_categories WHERE name = 'Phones'");
  const [a] = await pool.query("INSERT INTO addresses (city_id, street_number, street_name) VALUES (?, '1', 'Load Street')", [cityId]);
  officeAddress = a.insertId;
  const [o] = await pool.query("INSERT INTO lost_found_offices (address_id, name, email, phone, lfo_type) VALUES (?, ?, 'load@loadtest.test', '047 555 0100', 'mall')", [a.insertId, `Load Mall ${tag}`]);
  officeId = o.insertId;
  await pool.query("INSERT INTO shopping_malls (lfo_id, desk_location) VALUES (?, 'Information desk')", [officeId]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const members = await makePeople('member', MEMBERS, 'member', hash);
  const staff = await makePeople('staff', STAFF, 'office_admin', hash);
  check('Setup', `${MEMBERS} members and ${STAFF} office admins logged in at the same time`, [...members, ...staff].every((c) => c.cookie));

  // 1. Everyone reports a lost phone at the same moment.
  const lost = await Promise.all(members.map((c, i) => c.call('/api/items/lost', { method: 'POST', body: {
    itemName: `Black Samsung phone ${i}`, categoryId: phones, description: `Black Samsung phone in a blue cover, lost at the mall (${i}).`,
    colour: 'Black', brand: 'Samsung', cityId, dateLost: day(-1),
  } })));
  const [[saved]] = await pool.query(`SELECT COUNT(*) AS items, COUNT(DISTINCT l.lost_ref) AS refs,
      (SELECT COUNT(*) FROM owners o JOIN persons p ON p.id = o.person_id WHERE p.email LIKE ?) AS owners,
      (SELECT COUNT(*) FROM reporters r JOIN persons p ON p.id = r.person_id WHERE p.email LIKE ?) AS reporters
    FROM lost_items l JOIN persons p ON p.id = l.owner_id WHERE p.email LIKE ?`, [like, like, like]);
  check('Concurrency', `${MEMBERS} simultaneous lost reports: all accepted and saved`, count(lost, 201) === MEMBERS && saved.items === MEMBERS, `${saved.items} in the database`);
  check('Concurrency', 'Every report got its own reference number', saved.refs === MEMBERS);
  check('Concurrency', 'Each person became an owner and a reporter exactly once', saved.owners === MEMBERS && saved.reporters === MEMBERS);

  // 2. The office logs the phone that was handed in; the matching runs. Then it is run 10 more times at once.
  const found = await staff[0].call('/api/items/found', { method: 'POST', body: {
    itemName: 'Black Samsung phone', categoryId: phones, description: 'Black Samsung phone in a blue cover, handed in at the information desk.',
    colour: 'Black', brand: 'Samsung', cityId, officeId, foundDate: day(0), hiddenDetails: 'Wallpaper is a beach at sunset.', storageLocation: 'Safe 1',
  } });
  const foundId = found.data.id;
  const [[m1]] = await pool.query('SELECT COUNT(*) AS n, COUNT(DISTINCT lost_item_id) AS d FROM matches WHERE found_item_id = ?', [foundId]);
  check('Matching', 'Logging the found item suggests the similar lost reports', found.status === 201 && m1.n === found.data.suggestions && m1.n >= 2, `${m1.n} suggestions`);
  const reruns = await Promise.all(Array.from({ length: 10 }, (_, i) => staff[i % STAFF].call(`/api/matches/run/${foundId}`, { method: 'POST' })));
  const [[m2]] = await pool.query('SELECT COUNT(*) AS n, COUNT(DISTINCT lost_item_id) AS d FROM matches WHERE found_item_id = ?', [foundId]);
  check('Matching', '10 simultaneous "look again" runs: no errors and no duplicate suggestions', count(reruns, 200) === 10 && m2.n === m1.n && m2.d === m2.n);

  // 3. Two office admins confirm two different suggestions for the same found item at once.
  const [sugg] = await pool.query("SELECT id FROM matches WHERE found_item_id = ? AND match_status = 'suggested' ORDER BY score DESC LIMIT 2", [foundId]);
  const confirms = await Promise.all(sugg.map((s, i) => staff[i].call(`/api/matches/${s.id}`, { method: 'PUT', body: { decision: 'confirm' } })));
  const [[{ n: confirmed }]] = await pool.query("SELECT COUNT(*) AS n FROM matches WHERE found_item_id = ? AND match_status = 'confirmed'", [foundId]);
  check('Concurrency', 'Two simultaneous confirmations for one found item: exactly one is confirmed', count(confirms, 200) === 1 && confirmed === 1);
  check('Concurrency', 'The other admin gets a clear message, not a server error', count(confirms, 409) === 1, confirms.map((c) => c.data?.error).filter(Boolean).join(''));

  // 4. All members claim the same phone at once; one member double-clicks "Send claim" 5 times on another item.
  const claims = await Promise.all(members.map((c, i) => c.call('/api/claims', { method: 'POST', body: {
    foundItemId: foundId, lostItemId: lost[i].data.id, proofDescription: `It is my phone, number ${i}; the wallpaper is a photo of my family.`,
  } })));
  check('Concurrency', `${MEMBERS} simultaneous claims on one item: all recorded`, count(claims, 201) === MEMBERS);
  const second = await staff[1].call('/api/items/found', { method: 'POST', body: {
    itemName: 'Car keys with a red tag', categoryId: (await pool.query("SELECT id FROM item_categories WHERE name = 'Keys'"))[0][0].id,
    description: 'Two car keys on a ring with a red tag.', cityId, officeId, foundDate: day(0),
  } });
  const doubles = await Promise.all(Array.from({ length: 5 }, () => members[0].call('/api/claims', { method: 'POST', body: {
    foundItemId: second.data.id, proofDescription: 'My Toyota keys, the red tag has my initials on it.',
  } })));
  const [[{ n: dupRows }]] = await pool.query('SELECT COUNT(*) AS n FROM claims WHERE found_item_id = ?', [second.data.id]);
  check('Concurrency', 'The same claim sent 5 times at once: stored once, the rest refused', count(doubles, 201) === 1 && count(doubles, 409) === 4 && dupRows === 1);

  // 5. Three office admins approve three different claims on the phone at the same moment.
  const approvals = await Promise.all(staff.map((c, i) => c.call(`/api/claims/${claims[i].data.id}/decision`, { method: 'POST', body: { decision: 'approve' } })));
  const [[after]] = await pool.query(`SELECT SUM(c.approved_flag = 1) AS approved, SUM(s.code = 'rejected') AS rejected, SUM(s.code IN ('pending', 'under_review')) AS waiting,
      (SELECT status FROM items WHERE id = ?) AS item_status
    FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id WHERE c.found_item_id = ?`, [foundId, foundId]);
  check('Concurrency', '3 simultaneous approvals on one item: exactly one claim is approved', count(approvals, 200) === 1 && Number(after.approved) === 1 && after.item_status === 'claimed');
  check('Concurrency', 'The other admins get a clear message, not a server error', count(approvals, 409) === STAFF - 1, approvals.map((x) => x.data?.error).filter(Boolean).join(' | '));
  check('Concurrency', 'All other claims on the item are rejected; none left waiting', Number(after.rejected) === MEMBERS - 1 && Number(after.waiting) === 0);

  // 6. Response times.
  const browse = [];
  for (let i = 0; i < 40; i++) browse.push((await timed(() => members[i % MEMBERS].call(`/api/items?q=samsung&cityId=${cityId}`))).ms);
  check('Performance', 'Searching the found items: 95% of requests under 300 ms', pct(browse, 0.95) < 300, `median ${pct(browse, 0.5).toFixed(0)} ms, 95th percentile ${pct(browse, 0.95).toFixed(0)} ms`);
  const detail = [];
  for (let i = 0; i < 20; i++) detail.push((await timed(() => staff[i % STAFF].call(`/api/items/${foundId}`))).ms);
  check('Performance', 'An item with 30 claims and its matches opens in under 300 ms (95%)', pct(detail, 0.95) < 300, `95th percentile ${pct(detail, 0.95).toFixed(0)} ms`);
  const burst = await timed(() => Promise.all(members.map((x) => x.call('/api/stats/dashboard'))));
  check('Performance', `${MEMBERS} people opening their dashboard at the same moment: all answered within 2 s`, burst.ms < 2000 && burst.r.every((x) => x.status === 200), `${burst.ms.toFixed(0)} ms in total`);
  const report = await timed(() => staff[0].call(`/api/reports/summary?from=${day(-365)}&to=${day(0)}`));
  check('Performance', 'A 12-month office report is produced in under 1 s', report.ms < 1000 && report.r.status === 200, `${report.ms.toFixed(0)} ms`);
  const page = await timed(() => fetch(`${BASE}/browse.html`).then((x) => x.text()));
  check('Performance', 'A page loads in under 200 ms', page.ms < 200, `${page.ms.toFixed(0)} ms`);
}

async function cleanUp() {
  const [people] = await pool.query('SELECT id FROM persons WHERE email LIKE ?', [like]);
  const personIds = people.map((p) => p.id).concat([0]);
  const [items] = await pool.query(`SELECT i.id FROM items i LEFT JOIN lost_items l ON l.item_id = i.id LEFT JOIN found_items f ON f.item_id = i.id
    WHERE l.owner_id IN (?) OR l.reporter_id IN (?) OR f.lfo_id = ?`, [personIds, personIds, officeId || 0]);
  const itemIds = items.map((i) => i.id).concat([0]);
  await pool.query('DELETE FROM activity_log WHERE person_id IN (?) OR item_id IN (?)', [personIds, itemIds]);
  await pool.query('DELETE FROM claims WHERE found_item_id IN (?) OR owner_id IN (?)', [itemIds, personIds]);
  await pool.query('DELETE FROM matches WHERE lost_item_id IN (?) OR found_item_id IN (?)', [itemIds, itemIds]);
  await pool.query('DELETE FROM lost_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM found_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM items WHERE id IN (?)', [itemIds]);
  await pool.query('DELETE FROM it_admins WHERE lfo_id = ? OR person_id IN (?)', [officeId || 0, personIds]);
  await pool.query('DELETE FROM shopping_malls WHERE lfo_id = ?', [officeId || 0]);
  await pool.query('DELETE FROM lost_found_offices WHERE id = ?', [officeId || 0]);
  await pool.query('DELETE FROM persons WHERE id IN (?)', [personIds]);
  await pool.query('DELETE FROM addresses WHERE id = ?', [officeAddress || 0]);
  const [[{ n }]] = await pool.query('SELECT (SELECT COUNT(*) FROM persons WHERE email LIKE ?) + (SELECT COUNT(*) FROM lost_found_offices WHERE name = ?) AS n', [like, `Load Mall ${tag}`]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.stack || err.message); process.exitCode = 1; })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter((x) => x.pass).length;
    console.log(`\n${passed}/${results.length} concurrency and performance tests passed.${clean ? ' All test data was removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
