// End-to-end tests through the real HTTP API, acting as a system administrator, office admins
// of a mall, a police station and an airport, and three members (an owner, a finder and a
// dishonest claimant) at the same time. Self-contained: it creates a temporary system admin
// directly in the database, creates everything else through the API, and removes ALL of it at
// the end (even if a test fails). It never touches existing data.
// Needs the app running (npm start).
// Usage: node tools/test-api.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3005}`;
const tag = Date.now().toString(36).toLowerCase().slice(-6);
const emailFor = (who) => `${who}.${tag}@apitest.test`;
const userFor = (who) => `${who}.${tag}`;
const PASSWORD = 'Test-pass-123';

const pad = (n) => String(n).padStart(2, '0');
const day = (offset = 0) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const PNG = { name: 'wallet.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };

class Client {
  constructor() { this.cookie = ''; }
  async call(url, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (res.ok && !(res.headers.get('content-type') || '').includes('json')) return { contentType: res.headers.get('content-type') };
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(data?.error || res.statusText); err.status = res.status; throw err; }
    return data;
  }
  get(url) { return this.call(url); }
  post(url, body) { return this.call(url, { method: 'POST', body: body || {} }); }
  put(url, body) { return this.call(url, { method: 'PUT', body: body || {} }); }
  patch(url, body) { return this.call(url, { method: 'PATCH', body }); }
  del(url, body) { return this.call(url, { method: 'DELETE', body }); }
  login(username, password = PASSWORD) { this.cookie = ''; return this.post('/api/auth/login', { username, password }); }
}
const statusOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.status; } };

const results = [];
function check(area, name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const created = { offices: [], items: [], cities: [], categories: [], logs: [] };

async function main() {
  await pool.query("INSERT INTO persons (first_name, last_name, username, email, password_hash, role) VALUES ('Test', 'Sysadmin', ?, ?, ?, 'system_admin')",
    [userFor('sys'), emailFor('sys'), await bcrypt.hash(PASSWORD, 10)]);
  const sys = new Client();
  await sys.login(userFor('sys'));
  const cities = await sys.get('/api/cities');
  const city = (name) => cities.find((c) => c.name === name).id;
  const MTHATHA = city('Mthatha');
  const EL = city('East London');
  const KEMPTON = city('Kempton Park');
  const cats = await sys.get('/api/categories');
  const cat = (name) => cats.find((c) => c.name === name).id;

  // ---------- Locations and categories (system admin) ----------
  check('Locations', 'Postal code must be 4 digits (400)', await statusOf(() => sys.post('/api/admin/cities', { provinceId: cities[0].province_id, name: `Town ${tag}`, postalCode: '12' })) === 400);
  const town = await sys.post('/api/admin/cities', { provinceId: cities.find((c) => c.id === MTHATHA).province_id, name: `Town ${tag}`, postalCode: '5100' });
  created.cities.push(town.id);
  check('Locations', 'Duplicate city in a province rejected (409)', await statusOf(() => sys.post('/api/admin/cities', { provinceId: cities.find((c) => c.id === MTHATHA).province_id, name: `Town ${tag}`, postalCode: '5101' })) === 409);
  const category = await sys.post('/api/admin/categories', { name: `Umbrellas ${tag}` });
  created.categories.push(category.id);
  await sys.put(`/api/admin/categories/${category.id}`, { name: `Umbrellas ${tag}`, isActive: false });
  check('Categories', 'Inactive category is not offered', !(await sys.get('/api/categories')).some((c) => c.id === category.id));

  // ---------- Offices with their subtypes ----------
  const addr = (cityId, n) => ({ streetNumber: String(n), streetName: 'Test Street', suburb: 'Central', cityId });
  check('Offices', 'A mall needs its desk location (400)', await statusOf(() => sys.post('/api/offices', { name: `Plaza ${tag}`, lfoType: 'mall', email: 'desk@plaza.test', phone: '047 555 0100', ...addr(MTHATHA, 1) })) === 400);
  const mall = await sys.post('/api/offices', { name: `Plaza ${tag}`, lfoType: 'mall', email: 'desk@plaza.test', phone: '047 555 0100', deskLocation: 'Customer care, ground floor', hours: 'Mon–Sat 09:00–18:00', ...addr(MTHATHA, 1) });
  const police = await sys.post('/api/offices', { name: `Station ${tag}`, lfoType: 'police', email: 'lostfound@station.test', phone: '047 555 0200', precinct: 'Mthatha Central', ...addr(MTHATHA, 2) });
  check('Offices', 'Airport code must be 3 capital letters (400)', await statusOf(() => sys.post('/api/offices', { name: `Airport ${tag}`, lfoType: 'airport', email: 'lf@airport.test', phone: '011 555 0300', iataCode: 'J1', ...addr(KEMPTON, 3) })) === 400);
  const iata = `Z${tag.replace(/[^a-z]/g, 'q').slice(0, 2).toUpperCase().padEnd(2, 'Q')}`;
  const airport = await sys.post('/api/offices', { name: `Airport ${tag}`, lfoType: 'airport', email: 'lf@airport.test', phone: '011 555 0300', iataCode: iata, terminal: 'A', ...addr(KEMPTON, 3) });
  created.offices.push(mall.id, police.id, airport.id);
  check('Offices', 'Duplicate airport code rejected (409)', await statusOf(() => sys.post('/api/offices', { name: `Airport2 ${tag}`, lfoType: 'airport', email: 'x@airport.test', phone: '011 555 0301', iataCode: iata, ...addr(KEMPTON, 4) })) === 409);
  check('Offices', 'Duplicate office name rejected (409)', await statusOf(() => sys.post('/api/offices', { name: `Plaza ${tag}`, lfoType: 'mall', email: 'y@plaza.test', phone: '047 555 0101', deskLocation: 'Desk', ...addr(MTHATHA, 5) })) === 409);
  const mallRow = await sys.get(`/api/offices/${mall.id}`);
  const airRow = await sys.get(`/api/offices/${airport.id}`);
  check('Offices', 'Subtype rows with generated codes (MALL-, AIR-)', mallRow.office_code === `MALL-${String(mall.id).padStart(5, '0')}` && airRow.iata_code === iata && airRow.office_code.startsWith('AIR-'));
  const temp = await sys.post('/api/offices', { name: `Temp ${tag}`, lfoType: 'mall', email: 't@temp.test', phone: '047 555 0400', deskLocation: 'Info desk', ...addr(EL, 6) });
  created.offices.push(temp.id);
  await sys.put(`/api/offices/${temp.id}`, { name: `Temp ${tag}`, lfoType: 'police', email: 't@temp.test', phone: '047 555 0400', precinct: 'East London', ...addr(EL, 6) });
  const [[subs]] = await pool.query('SELECT (SELECT COUNT(*) FROM shopping_malls WHERE lfo_id = ?) AS mall, (SELECT COUNT(*) FROM police_stations WHERE lfo_id = ?) AS police', [temp.id, temp.id]);
  check('Offices', 'Changing the type replaces the subtype row (disjoint)', subs.mall === 0 && subs.police === 1);
  await sys.del(`/api/offices/${temp.id}`);
  check('Offices', 'An office without reports can be deleted', await statusOf(() => sys.get(`/api/offices/${temp.id}`)) === 404);

  // ---------- Accounts ----------
  const a1Info = await sys.post('/api/admin/persons', { firstName: 'Ayanda', lastName: 'Mall', email: emailFor('a1'), username: userFor('a1'), role: 'office_admin', officeId: mall.id });
  check('Accounts', 'System admin creates an office admin with a temporary password', !!a1Info.tempPassword);
  check('Accounts', 'An office admin needs an office (400)', await statusOf(() => sys.post('/api/admin/persons', { firstName: 'No', lastName: 'Office', email: emailFor('nooffice'), role: 'office_admin' })) === 400);
  const a1 = new Client();
  await a1.login(userFor('a1'), a1Info.tempPassword);
  check('Accounts', 'Temporary password must be changed first (403)', await statusOf(() => a1.get('/api/items')) === 403);
  await a1.put('/api/auth/password', { currentPassword: a1Info.tempPassword, newPassword: PASSWORD });
  const a3Info = await sys.post('/api/admin/persons', { firstName: 'Bheki', lastName: 'Police', email: emailFor('a3'), username: userFor('a3'), role: 'office_admin', officeId: police.id });
  const a3 = new Client();
  await a3.login(userFor('a3'), a3Info.tempPassword);
  await a3.put('/api/auth/password', { currentPassword: a3Info.tempPassword, newPassword: PASSWORD });

  const m1 = new Client(); const m2 = new Client(); const m3 = new Client();
  check('Accounts', 'Register: bad street number rejected (400)', await statusOf(() => m1.post('/api/auth/register', { firstName: 'Thandi', lastName: 'Owner', username: userFor('m1'), email: emailFor('m1'), password: PASSWORD, streetNumber: 'abc', streetName: 'Main', cityId: MTHATHA })) === 400);
  const u1 = await m1.post('/api/auth/register', { firstName: 'Thandi', lastName: 'Owner', username: userFor('m1'), email: emailFor('m1'), password: PASSWORD, phone: '071 555 0101', dob: '2001-05-04', streetNumber: '12', streetName: 'Nelson Mandela Drive', suburb: 'Southernwood', cityId: MTHATHA });
  const me1 = await m1.get('/api/auth/me');
  check('Accounts', 'Register: member with address; not an owner until they report', u1.role === 'member' && me1.cityId === MTHATHA && me1.ownerCode === null);
  check('Accounts', 'Register: taken username rejected (409)', await statusOf(() => m2.post('/api/auth/register', { firstName: 'X', lastName: 'Y', username: userFor('m1'), email: emailFor('x'), password: PASSWORD })) === 409);
  check('Accounts', 'Register: date of birth in the future rejected (400)', await statusOf(() => m2.post('/api/auth/register', { firstName: 'X', lastName: 'Y', username: userFor('x'), email: emailFor('x'), password: PASSWORD, dob: day(5) })) === 400);
  const u2 = await m2.post('/api/auth/register', { firstName: 'Sipho', lastName: 'Finder', username: userFor('m2'), email: emailFor('m2'), password: PASSWORD });
  const u3 = await m3.post('/api/auth/register', { firstName: 'Lwazi', lastName: 'Chancer', username: userFor('m3'), email: emailFor('m3'), password: PASSWORD });
  check('Accounts', 'Log in with email', (await new Client().login(emailFor('m1'))).id === u1.id);
  check('Accounts', 'Wrong password rejected (401)', await statusOf(() => new Client().login(userFor('m1'), 'nope-nope')) === 401);

  // ---------- Office admins manage their own office's admins ----------
  const a2Info = await a1.post(`/api/offices/${mall.id}/admins`, { firstName: 'Zola', lastName: 'Helper', email: emailFor('a2'), username: userFor('a2') });
  check('Office admins', 'An office admin adds a new admin to their office', !!a2Info.tempPassword && (await a1.get(`/api/offices/${mall.id}`)).admins.length === 2);
  check('Office admins', "An office admin can't manage another office's admins (403)", await statusOf(() => a1.post(`/api/offices/${police.id}/admins`, { login: userFor('m3') })) === 403);
  check('Office admins', "Members can't see an office's admins", (await m1.get(`/api/offices/${mall.id}`)).admins === undefined);
  check('Office admins', 'An admin of another office cannot be added (409)', await statusOf(() => a1.post(`/api/offices/${mall.id}/admins`, { login: userFor('a3') })) === 409);
  const a1Id = (await a1.get('/api/auth/me')).id;
  check('Office admins', 'An office admin cannot remove themselves (400)', await statusOf(() => a1.del(`/api/offices/${mall.id}/admins/${a1Id}`)) === 400);
  await a1.del(`/api/offices/${mall.id}/admins/${a2Info.personId}`);
  const [[a2Row]] = await pool.query('SELECT role FROM persons WHERE id = ?', [a2Info.personId]);
  check('Office admins', 'A removed admin becomes an ordinary member', a2Row.role === 'member');
  check('Office admins', 'Members cannot create offices (403)', await statusOf(() => m1.post('/api/offices', { name: 'Mine' })) === 403);

  // ---------- Reporting ----------
  const lostBody = { itemName: 'Black leather wallet', categoryId: cat('Wallets and purses'), description: 'Black leather wallet with a red stripe, contains bank cards and my student card', colour: 'Black', brand: 'Guess', cityId: MTHATHA, placeDetail: 'Taxi rank near the Plaza', dateLost: day(-2) };
  check('Report', 'A lost date in the future rejected (400)', await statusOf(() => m1.post('/api/items/lost', { ...lostBody, dateLost: day(3) })) === 400);
  check('Report', 'A description shorter than 5 characters rejected (400)', await statusOf(() => m1.post('/api/items/lost', { ...lostBody, description: 'bag' })) === 400);
  check('Report', 'More than 3 photos rejected (400)', await statusOf(() => m1.post('/api/items/lost', { ...lostBody, photos: [PNG, PNG, PNG, PNG] })) === 400);
  check('Report', 'An inactive category rejected (400)', await statusOf(() => m1.post('/api/items/lost', { ...lostBody, categoryId: category.id })) === 400);
  const lost = await m1.post('/api/items/lost', { ...lostBody, photos: [PNG] });
  created.items.push(lost.id);
  check('Categories', 'A category in use cannot be deleted (409)', await statusOf(() => sys.del(`/api/admin/categories/${cat('Wallets and purses')}`)) === 409);
  const lostItem = await m1.get(`/api/items/${lost.id}`);
  const me1b = await m1.get('/api/auth/me');
  check('Report', 'Lost report: reference L-…, the member becomes owner and reporter (overlapping subtypes)',
    lostItem.ref === `L-${String(lost.id).padStart(6, '0')}` && me1b.ownerCode === `OWN-${String(u1.id).padStart(6, '0')}` && me1b.reporterCode.startsWith('REP-'));

  const foundBody = { itemName: 'Black wallet', categoryId: cat('Wallets and purses'), description: 'Black leather wallet found on a bench, red stripe on the side', colour: 'black', cityId: MTHATHA, placeDetail: 'Plaza food court', foundDate: day(-1), officeId: mall.id, hiddenDetails: 'Student card of T. Owner inside, FNB card ending 4411, R50 note' };
  const found = await m2.post('/api/items/found', { ...foundBody, photos: [{ ...PNG, isPublic: false }] });
  created.items.push(found.id);
  const foundForM2 = await m2.get(`/api/items/${found.id}`);
  check('Report', 'Found report by a member: reference F-…, waiting to be received by the office', foundForM2.ref.startsWith('F-') && foundForM2.received_at === null && foundForM2.office.name === `Plaza ${tag}`);
  check('Matching', 'A matching suggestion is made at once', found.suggestions >= 1);

  // ---------- Visibility ----------
  const forM3 = await m3.get(`/api/items/${found.id}`);
  check('Visibility', 'Other members see the found item without hidden details, finder or private photos',
    forM3.hidden_details === undefined && forM3.reporter_name === undefined && forM3.photos.length === 0 && forM3.claims.length === 0);
  check('Visibility', "Members can't see someone else's lost report (404)", await statusOf(() => m3.get(`/api/items/${lost.id}`)) === 404);
  const forA1 = await a1.get(`/api/items/${found.id}`);
  check('Visibility', 'The office admin sees hidden details, finder, private photo and can manage', forA1.canManage && forA1.hidden_details.includes('4411') && forA1.reporter_name === 'Sipho Finder' && forA1.photos.length === 1);
  check('Visibility', 'Office admins see lost reports in their province', (await a3.get(`/api/items/${lost.id}`)).canManage === true);
  check('Visibility', "An admin of another office can see the found item but not manage it", (await a3.get(`/api/items/${found.id}`)).canManage === false);
  const privatePhoto = forA1.photos[0].id;
  check('Visibility', 'A private photo is not served to other members (404)', await statusOf(() => m3.get(`/api/items/${found.id}/photos/${privatePhoto}`)) === 404);
  check('Visibility', 'The office admin can open the private photo', (await a1.get(`/api/items/${found.id}/photos/${privatePhoto}`)).contentType === 'image/png');
  check('Search', 'Search by words and by reference', (await m3.get('/api/items?q=wallet&type=found')).some((i) => i.id === found.id)
    && (await a1.get(`/api/items?q=${forA1.ref}`)).length === 1);

  // ---------- Matching ----------
  const suggestions = await a1.get('/api/matches?status=suggested');
  const match = suggestions.find((m) => m.lost_item_id === lost.id && m.found_item_id === found.id);
  check('Matching', 'The office admin sees the suggestion with a score', !!match && match.score >= 55, match && `score ${match.score}`);
  check('Matching', 'Members cannot confirm matches (403)', await statusOf(() => m1.put(`/api/matches/${match.id}`, { decision: 'confirm' })) === 403);
  check('Matching', 'An admin of another office cannot confirm it (403)', await statusOf(() => a3.put(`/api/matches/${match.id}`, { decision: 'confirm' })) === 403);
  await a1.put(`/api/matches/${match.id}`, { decision: 'confirm' });
  const ownerMatches = await m1.get('/api/matches');
  check('Matching', 'Confirmed: both items matched; the owner sees where the item is', (await m1.get(`/api/items/${lost.id}`)).status === 'matched'
    && ownerMatches.length === 1 && ownerMatches[0].office_name === `Plaza ${tag}` && ownerMatches[0].found_description === null);
  check('Matching', 'Deciding twice rejected (409)', await statusOf(() => a1.put(`/api/matches/${match.id}`, { decision: 'reject' })) === 409);
  check('Editing', 'The owner can no longer edit a matched report (409)', await statusOf(() => m1.put(`/api/items/${lost.id}`, lostBody)) === 409);

  // ---------- Claims ----------
  check('Claims', "The finder can't claim the item they handed in (409)", await statusOf(() => m2.post('/api/claims', { foundItemId: found.id, proofDescription: 'It is mine, it is mine, really mine.' })) === 409);
  check('Claims', 'The description of proof must be at least 20 characters (400)', await statusOf(() => m3.post('/api/claims', { foundItemId: found.id, proofDescription: 'Mine.' })) === 400);
  const c3 = await m3.post('/api/claims', { foundItemId: found.id, proofDescription: 'It is a black wallet, I lost it in town last week.' });
  const c1 = await m1.post('/api/claims', { foundItemId: found.id, lostItemId: lost.id, proofDescription: 'My student card (Thandi Owner) is inside, an FNB card ending 4411 and a R50 note.' });
  check('Claims', 'A second open claim by the same person rejected (409)', await statusOf(() => m1.post('/api/claims', { foundItemId: found.id, proofDescription: 'Again: student card, FNB card ending 4411.' })) === 409);
  check('Claims', "Members can't see other people's claims (404)", await statusOf(() => m3.get(`/api/claims/${c1.id}`)) === 404);
  check('Claims', 'The office admin sees both claims with the hidden details to compare', (await a1.get(`/api/claims/${c1.id}`)).hidden_details.includes('4411')
    && (await a1.get('/api/claims?open=1')).filter((c) => c.found_item_id === found.id).length === 2);
  check('Claims', 'Approving before the office has the item rejected (409)', await statusOf(() => a1.post(`/api/claims/${c1.id}/decision`, { decision: 'approve' })) === 409);
  await a1.post(`/api/items/${found.id}/receive`, { storageLocation: 'Shelf B2' });
  check('Claims', 'Receiving twice rejected (409)', await statusOf(() => a1.post(`/api/items/${found.id}/receive`, {})) === 409);
  await a1.post(`/api/claims/${c1.id}/decision`, { decision: 'review' });
  check('Claims', 'Review started: Under review', (await m1.get(`/api/claims/${c1.id}`)).status_code === 'under_review');
  check('Claims', 'Rejecting needs a reason (400)', await statusOf(() => a1.post(`/api/claims/${c3.id}/decision`, { decision: 'reject' })) === 400);
  check('Claims', "Staff of another office can't see or decide it (404)", await statusOf(() => a3.post(`/api/claims/${c3.id}/decision`, { decision: 'reject', notes: 'Not ours' })) === 404);
  await a1.post(`/api/claims/${c3.id}/decision`, { decision: 'reject', notes: 'Could not describe the contents.' });
  await a1.post(`/api/claims/${c1.id}/decision`, { decision: 'approve', notes: 'Student card and card number match.' });
  check('Claims', 'Approved: found and lost items become "claimed"', (await a1.get(`/api/items/${found.id}`)).status === 'claimed' && (await m1.get(`/api/items/${lost.id}`)).status === 'claimed');
  check('Claims', 'A rejected claimant sees the reason', (await m3.get(`/api/claims/${c3.id}`)).decision_notes === 'Could not describe the contents.');
  check('Claims', 'The item can no longer be claimed (409)', await statusOf(() => m3.post('/api/claims', { foundItemId: found.id, proofDescription: 'Student card inside and the bank card 4411.' })) === 409);
  check('Claims', 'Handing over without checking ID rejected (400)', await statusOf(() => a1.post(`/api/claims/${c1.id}/return`, {})) === 400);
  await a1.post(`/api/claims/${c1.id}/return`, { idVerified: true });
  const returned = await m1.get(`/api/claims/${c1.id}`);
  check('Claims', 'Returned: restitution date recorded, both items "returned"', returned.status_code === 'returned' && !!returned.restitution_date
    && (await m1.get(`/api/items/${lost.id}`)).status === 'returned');
  check('Claims', 'A returned claim cannot be withdrawn (409)', await statusOf(() => m1.post(`/api/claims/${c1.id}/withdraw`)) === 409);

  // Concurrency: two admins approve two claims on the same item at the same moment.
  const f2 = await a1.post('/api/items/found', { itemName: 'Samsung phone', categoryId: cat('Phones'), description: 'Samsung phone in a blue cover found at the till', colour: 'Blue', cityId: MTHATHA, foundDate: day(0), officeId: mall.id, hiddenDetails: 'Lock screen photo of a dog' });
  created.items.push(f2.id);
  check('Claims', 'An item logged by the office admin is received at once', !!(await a1.get(`/api/items/${f2.id}`)).received_at);
  const k1 = await m1.post('/api/claims', { foundItemId: f2.id, proofDescription: 'Blue cover, lock screen is my dog Bruno, Samsung A15.' });
  const k3 = await m3.post('/api/claims', { foundItemId: f2.id, proofDescription: 'It is my Samsung phone with a blue cover on it.' });
  const both = await Promise.all([
    statusOf(() => a1.post(`/api/claims/${k1.id}/decision`, { decision: 'approve' })),
    statusOf(() => sys.post(`/api/claims/${k3.id}/decision`, { decision: 'approve' })),
  ]);
  const [[{ approved }]] = await pool.query('SELECT COUNT(*) AS approved FROM claims WHERE found_item_id = ? AND approved_flag = 1', [f2.id]);
  check('Claims', 'Two approvals at the same moment: only one claim is approved', approved === 1 && both.includes('ok') && both.filter((s) => s === 'ok').length === 1, both.join(','));

  // ---------- Close, reopen, delete ----------
  const f3 = await m2.post('/api/items/found', { ...foundBody, itemName: 'Car keys', categoryId: cat('Keys'), description: 'Toyota car keys on a ring', hiddenDetails: null });
  created.items.push(f3.id);
  await m2.del(`/api/items/${f3.id}`);
  check('Delete', 'The finder deletes their own open report entered by mistake', await statusOf(() => m2.get(`/api/items/${f3.id}`)) === 404);
  check('Delete', 'A report with claims cannot be deleted (409)', await statusOf(() => a1.del(`/api/items/${found.id}`)) === 409);
  const f4 = await m2.post('/api/items/found', { ...foundBody, itemName: 'Gold ring', categoryId: cat('Jewellery and watches'), description: 'Gold ring with a small stone', hiddenDetails: 'Engraved "N & S 2019"' });
  created.items.push(f4.id);
  const k4 = await m3.post('/api/claims', { foundItemId: f4.id, proofDescription: 'It is my gold ring with a small stone on it.' });
  await a1.post(`/api/items/${f4.id}/close`, { reason: 'Fraudulent report: ring was never handed in' });
  check('Close', 'Closing a fraudulent report rejects its open claims with the reason', (await m3.get(`/api/claims/${k4.id}`)).status_code === 'rejected'
    && (await a1.get(`/api/items/${f4.id}`)).status === 'closed');
  check('Close', 'A closed found item disappears from the members\' board', !(await m3.get('/api/items?type=found')).some((i) => i.id === f4.id));
  check('Close', 'Members cannot reopen (403)', await statusOf(() => m2.post(`/api/items/${f4.id}/reopen`)) === 403);
  const lost2 = await m1.post('/api/items/lost', { ...lostBody, itemName: 'Prescription glasses', categoryId: cat('Glasses'), description: 'Brown frame glasses in a black case' });
  created.items.push(lost2.id);
  await m1.post(`/api/items/${lost2.id}/close`, { reason: 'Found them at home' });
  check('Close', 'The owner closes their own lost report', (await m1.get(`/api/items/${lost2.id}`)).status === 'closed');
  await a3.post(`/api/items/${lost2.id}/reopen`);
  check('Close', 'An office admin in the province reopens it', (await m1.get(`/api/items/${lost2.id}`)).status === 'open');

  // ---------- Photos ----------
  await m1.post(`/api/items/${lost2.id}/photos`, { photos: [PNG, PNG] });
  check('Photos', 'Owner adds photos; a 4th rejected (400)', (await m1.get(`/api/items/${lost2.id}`)).photos.length === 2
    && await statusOf(() => m1.post(`/api/items/${lost2.id}/photos`, { photos: [PNG, PNG] })) === 400);

  // ---------- Reports ----------
  check('Reports', 'Members cannot open reports (403)', await statusOf(() => m1.get(`/api/reports/summary?from=${day(-30)}&to=${day(0)}`)) === 403);
  const rep = await a1.get(`/api/reports/summary?from=${day(-30)}&to=${day(0)}&officeId=${police.id}`);
  check('Reports', "An office admin's report is limited to their own office", rep.filters.officeId === mall.id && rep.byOffice.every((o) => o.name === `Plaza ${tag}`));
  const repAll = await sys.get(`/api/reports/summary?from=${day(-30)}&to=${day(0)}&cityId=${MTHATHA}`);
  check('Reports', 'Totals, recoveries and claims for the area', repAll.totals.found >= 3 && repAll.totals.returned >= 1 && repAll.totals.lost_recovered >= 1 && repAll.claims.returned >= 1);
  check('Reports', 'People with 2+ rejected claims are flagged (possible fraud)', repAll.flagged.some((f) => f.username === userFor('m3')));
  const dash = await a1.get('/api/stats/dashboard');
  check('Dashboard', 'Office dashboard counts claims, matches and items held', dash.items_held >= 1 && dash.claims_to_decide !== undefined && dash.lost_in_area >= 1);

  // ---------- Administration ----------
  check('Admin', 'Office admins cannot open administration (403)', await statusOf(() => a1.get('/api/admin/persons')) === 403);
  await sys.patch(`/api/admin/persons/${u3.id}`, { isActive: false });
  check('Admin', 'A deactivated account cannot log in (403) and its session ends (401)', await statusOf(() => new Client().login(userFor('m3'))) === 403
    && await statusOf(() => m3.get('/api/items')) === 401);
  check('Admin', 'Rejected claims are shown per person', (await sys.get(`/api/admin/persons?search=${userFor('m3')}`))[0].rejected_claims >= 2);
  check('Admin', 'Making someone an office admin needs an office (400)', await statusOf(() => sys.patch(`/api/admin/persons/${u2.id}`, { role: 'office_admin' })) === 400);
  const sysId = (await sys.get('/api/auth/me')).id;
  check('Admin', "The system admin can't demote themselves (400)", await statusOf(() => sys.patch(`/api/admin/persons/${sysId}`, { role: 'member' })) === 400);
  check('Admin', 'Activity log records the claim decisions', (await sys.get('/api/admin/activity?action=claim_approved')).length >= 2);

  // ---------- Records are kept ----------
  // The deleted account's log entries lose their person link; note them so the clean-up still finds them.
  const [m2Logs] = await pool.query('SELECT a.id FROM activity_log a JOIN persons p ON p.id = a.person_id WHERE p.email = ?', [emailFor('m2')]);
  created.logs.push(...m2Logs.map((l) => l.id));
  await m2.del('/api/auth/me', { password: PASSWORD });
  const [[kept]] = await pool.query('SELECT reporter_id FROM found_items WHERE item_id = ?', [found.id]);
  check('Records', "Deleting the finder's account keeps the found item (reporter link empty)", kept && kept.reporter_id === null);
  const [[addr1]] = await pool.query('SELECT address_id FROM persons WHERE id = ?', [u1.id]);
  await m1.put('/api/auth/me', { firstName: 'Thandi', lastName: 'Owner', email: emailFor('m1') });
  const [[gone]] = await pool.query('SELECT COUNT(*) AS n FROM addresses WHERE id = ?', [addr1.address_id]);
  check('Records', 'Removing an address from the profile deletes the address row', gone.n === 0);
}

async function cleanUp() {
  const like = `%.${tag}@apitest.test`;
  const [people] = await pool.query('SELECT id, address_id FROM persons WHERE email LIKE ?', [like]);
  const personIds = people.map((p) => p.id).concat([0]);
  const officeIds = created.offices.concat([0]);
  const [items] = await pool.query(`SELECT i.id FROM items i LEFT JOIN lost_items l ON l.item_id = i.id LEFT JOIN found_items f ON f.item_id = i.id
    WHERE i.id IN (?) OR l.owner_id IN (?) OR l.reporter_id IN (?) OR f.reporter_id IN (?) OR f.lfo_id IN (?) OR l.lfo_id IN (?)`,
  [created.items.concat([0]), personIds, personIds, personIds, officeIds, officeIds]);
  const itemIds = items.map((i) => i.id).concat([0]);
  await pool.query('DELETE FROM activity_log WHERE person_id IN (?) OR item_id IN (?) OR claim_id IN (SELECT id FROM claims WHERE found_item_id IN (?)) OR id IN (?)',
    [personIds, itemIds, itemIds, created.logs.concat([0])]);
  await pool.query('DELETE FROM claims WHERE found_item_id IN (?) OR owner_id IN (?)', [itemIds, personIds]);
  await pool.query('DELETE FROM matches WHERE lost_item_id IN (?) OR found_item_id IN (?)', [itemIds, itemIds]);
  await pool.query('DELETE FROM lost_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM found_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM items WHERE id IN (?)', [itemIds]);
  const [offices] = await pool.query('SELECT id, address_id FROM lost_found_offices WHERE id IN (?) OR name LIKE ?', [officeIds, `%${tag}`]);
  const oIds = offices.map((o) => o.id).concat([0]);
  await pool.query('DELETE FROM it_admins WHERE lfo_id IN (?) OR person_id IN (?)', [oIds, personIds]);
  for (const t of ['shopping_malls', 'police_stations', 'airports']) await pool.query(`DELETE FROM ${t} WHERE lfo_id IN (?)`, [oIds]);
  await pool.query('DELETE FROM lost_found_offices WHERE id IN (?)', [oIds]);
  await pool.query('DELETE FROM persons WHERE id IN (?)', [personIds]);
  const addressIds = people.map((p) => p.address_id).concat(offices.map((o) => o.address_id)).filter(Boolean).concat([0]);
  await pool.query('DELETE FROM addresses WHERE id IN (?)', [addressIds]);
  if (created.categories.length) await pool.query('DELETE FROM item_categories WHERE id IN (?)', [created.categories]);
  if (created.cities.length) await pool.query('DELETE FROM cities WHERE id IN (?)', [created.cities]);
  const [[{ n }]] = await pool.query(`SELECT (SELECT COUNT(*) FROM persons WHERE email LIKE ?) + (SELECT COUNT(*) FROM lost_found_offices WHERE name LIKE ?)
    + (SELECT COUNT(*) FROM items WHERE id IN (?)) AS n`, [like, `%${tag}`, created.items.concat([0])]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.stack || err.message); results.push(false); })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} API tests passed.${clean ? ' All test accounts and data were removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
