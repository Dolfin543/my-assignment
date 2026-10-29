// Realistic, fictional sample data for demonstrations and screenshots.
// Everyone uses the sample.test email domain and the offices have fixed names, so the whole
// set can be removed again without touching real data.
//   node tools/sample-data.js seed    -> create it
//   node tools/sample-data.js clean   -> delete all of it
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { suggestMatches } = require('../lib/matching');

const BASE = `http://localhost:${process.env.PORT || 3005}`;
const PASSWORD = 'Sample-pass-123'; // sample accounts only; deleted by "clean"
const DOMAIN = '@sample.test';

// [name, type, city, street no, street, suburb, email, phone, hours, subtype fields]
const OFFICES = [
  ['Riverside Mall', 'mall', 'Mthatha', '1', 'Sutherland Street', 'Mthatha Central', 'lostfound@riversidemall.test', '047 555 0100', 'Mon–Sat 09:00–18:00, Sun 09:00–14:00', { desk_location: 'Customer care desk, ground floor' }],
  ['Mthatha Central Police Station', 'police', 'Mthatha', '22', 'Madeira Street', 'Mthatha Central', 'mthatha.lostfound@police.test', '047 555 0200', 'Open 24 hours', { precinct: 'Mthatha Central' }],
  ['Buffalo City Mall', 'mall', 'East London', '50', 'Oxford Street', 'Quigney', 'help@buffalocitymall.test', '043 555 0300', 'Mon–Sun 09:00–19:00', { desk_location: 'Information kiosk, upper level' }],
  ['Eastern Cape Regional Airport', 'airport', 'East London', '5', 'Settlers Way', 'Buffalo Flats', 'lostproperty@ecairport.test', '043 555 0400', 'Daily 05:00–22:00', { iata_code: 'ECR', terminal: 'Arrivals hall' }],
  ['Gqeberha Harbour Police Station', 'police', 'Gqeberha', '8', 'Strand Street', 'Central', 'harbour.lostfound@police.test', '041 555 0500', 'Open 24 hours', { precinct: 'Gqeberha Harbour' }],
];
// [username, first, last, role, office (for office admins), city, phone]
const PEOPLE = [
  ['nomvula', 'Nomvula', 'Dlamini', 'system_admin', null, 'Mthatha', '047 555 0001'],
  ['sizwe', 'Sizwe', 'Ngcobo', 'office_admin', 'Riverside Mall', 'Mthatha', '047 555 0101'],
  ['lindiwe', 'Lindiwe', 'Mahlangu', 'office_admin', 'Mthatha Central Police Station', 'Mthatha', '047 555 0201'],
  ['pieter', 'Pieter', 'van Wyk', 'office_admin', 'Buffalo City Mall', 'East London', '043 555 0301'],
  ['ayesha', 'Ayesha', 'Patel', 'office_admin', 'Eastern Cape Regional Airport', 'East London', '043 555 0401'],
  ['thandi', 'Thandi', 'Mokoena', 'member', null, 'Mthatha', '071 555 0142'],
  ['sipho', 'Sipho', 'Ndlovu', 'member', null, 'Mthatha', '072 555 0187'],
  ['ayanda', 'Ayanda', 'Mthembu', 'member', null, 'Mthatha', '073 555 0110'],
  ['lerato', 'Lerato', 'Khumalo', 'member', null, 'East London', '074 555 0163'],
  ['zanele', 'Zanele', 'Dube', 'member', null, 'East London', null],
  ['johan', 'Johan', 'Botha', 'member', null, 'East London', '076 555 0171'],
  ['lwazi', 'Lwazi', 'Nkosi', 'member', null, 'Mthatha', null],
];

const at = (daysAgo, hour = 10, minute = 0) => { const d = new Date(Date.now() - daysAgo * 864e5); d.setHours(hour, minute, 0, 0); return d; };
const day = (daysAgo) => { const d = at(daysAgo); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function clean() {
  const [people] = await pool.query('SELECT id, address_id FROM persons WHERE email LIKE ?', [`%${DOMAIN}`]);
  const [offices] = await pool.query('SELECT id, address_id, lfo_type FROM lost_found_offices WHERE name IN (?)', [OFFICES.map((o) => o[0])]);
  const pIds = people.map((p) => p.id).concat([0]);
  const oIds = offices.map((o) => o.id).concat([0]);
  const [items] = await pool.query(`SELECT i.id FROM items i LEFT JOIN lost_items l ON l.item_id = i.id LEFT JOIN found_items f ON f.item_id = i.id
    WHERE l.owner_id IN (?) OR l.reporter_id IN (?) OR f.reporter_id IN (?) OR f.lfo_id IN (?) OR l.lfo_id IN (?)`, [pIds, pIds, pIds, oIds, oIds]);
  const iIds = items.map((i) => i.id).concat([0]);
  await pool.query('DELETE FROM activity_log WHERE person_id IN (?) OR item_id IN (?) OR claim_id IN (SELECT id FROM claims WHERE found_item_id IN (?) OR owner_id IN (?))', [pIds, iIds, iIds, pIds]);
  await pool.query('DELETE FROM claims WHERE found_item_id IN (?) OR owner_id IN (?)', [iIds, pIds]);
  await pool.query('DELETE FROM matches WHERE lost_item_id IN (?) OR found_item_id IN (?)', [iIds, iIds]);
  await pool.query('DELETE FROM lost_items WHERE item_id IN (?)', [iIds]);
  await pool.query('DELETE FROM found_items WHERE item_id IN (?)', [iIds]);
  await pool.query('DELETE FROM items WHERE id IN (?)', [iIds]);
  await pool.query('DELETE FROM it_admins WHERE lfo_id IN (?) OR person_id IN (?)', [oIds, pIds]);
  for (const t of ['shopping_malls', 'police_stations', 'airports']) await pool.query(`DELETE FROM ${t} WHERE lfo_id IN (?)`, [oIds]);
  await pool.query('DELETE FROM lost_found_offices WHERE id IN (?)', [oIds]);
  await pool.query('DELETE FROM persons WHERE id IN (?)', [pIds]);
  const addresses = people.map((p) => p.address_id).concat(offices.map((o) => o.address_id)).filter(Boolean);
  if (addresses.length) await pool.query('DELETE FROM addresses WHERE id IN (?)', [addresses]);
  console.log('Sample data removed.');
}

async function seed() {
  await clean();
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const ins = async (sql, params) => (await pool.query(sql, params))[0].insertId;
  const [cityRows] = await pool.query('SELECT id, name FROM cities');
  const city = (name) => cityRows.find((c) => c.name === name).id;
  const [catRows] = await pool.query('SELECT id, name FROM item_categories');
  const cat = (name) => catRows.find((c) => c.name === name).id;
  const status = {};
  for (const s of await q('SELECT id, code FROM claim_statuses')) status[s.code] = s.id;

  // ---------- offices
  const office = {};
  for (const [name, type, cityName, no, street, suburb, email, phone, hours, sub] of OFFICES) {
    const addressId = await ins('INSERT INTO addresses (city_id, street_number, street_name, suburb) VALUES (?, ?, ?, ?)', [city(cityName), no, street, suburb]);
    office[name] = await ins('INSERT INTO lost_found_offices (address_id, name, email, phone, lfo_type, hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [addressId, name, email, phone, type, hours, at(120)]);
    const table = { mall: 'shopping_malls', police: 'police_stations', airport: 'airports' }[type];
    await q(`INSERT INTO ${table} SET ?`, [{ ...sub, lfo_id: office[name] }]);
  }

  // ---------- people
  const hash = await bcrypt.hash(PASSWORD, 10);
  const person = {};
  let n = 10;
  for (const [username, first, last, role, officeName, cityName, phone] of PEOPLE) {
    const addressId = role === 'member' ? await ins('INSERT INTO addresses (city_id, street_number, street_name) VALUES (?, ?, ?)', [city(cityName), String(n++), 'Example Road']) : null;
    person[username] = await ins(`INSERT INTO persons (address_id, username, first_name, last_name, dob, email, phone, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [addressId, username, first, last, `199${n % 10}-0${(n % 9) + 1}-1${n % 9}`, `${username}${DOMAIN}`, phone, hash, role, at(100)]);
    if (officeName) await q('INSERT INTO it_admins (lfo_id, person_id, added_by, created_at) VALUES (?, ?, ?, ?)', [office[officeName], person[username], null, at(100)]);
  }
  const log = (who, itemId, claimId, action, details, when) => q('INSERT INTO activity_log (person_id, item_id, claim_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [person[who] || null, itemId, claimId, action, details || null, when]);

  // ---------- items
  async function lost(owner, s) {
    const id = await ins('INSERT INTO items (item_type, item_name, category_id, description, colour, brand, city_id, place_detail, status, date_reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['lost', s.name, cat(s.cat), s.desc, s.colour || null, s.brand || null, city(s.city), s.place || null, s.status || 'open', at(s.ago - 0.2, 18)]);
    await q('INSERT IGNORE INTO owners (person_id, created_at) VALUES (?, ?)', [person[owner], at(s.ago)]);
    await q('INSERT IGNORE INTO reporters (person_id, created_at) VALUES (?, ?)', [person[owner], at(s.ago)]);
    await q('INSERT INTO lost_items (item_id, reporter_id, owner_id, lfo_id, date_lost) VALUES (?, ?, ?, ?, ?)', [id, person[owner], person[owner], s.office ? office[s.office] : null, day(s.ago)]);
    await log(owner, id, null, 'lost_reported', s.name, at(s.ago - 0.2, 18));
    return id;
  }
  async function found(reporter, s) {
    const id = await ins('INSERT INTO items (item_type, item_name, category_id, description, colour, brand, city_id, place_detail, status, date_reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['found', s.name, cat(s.cat), s.desc, s.colour || null, s.brand || null, city(s.city), s.place || null, s.status || 'open', at(s.ago, 15)]);
    await q('INSERT IGNORE INTO reporters (person_id, created_at) VALUES (?, ?)', [person[reporter], at(s.ago)]);
    const received = s.received === false ? null : at(s.ago, 16);
    await q('INSERT INTO found_items (item_id, reporter_id, lfo_id, found_date, received_at, received_by, storage_location, hidden_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, person[reporter], office[s.office], day(s.ago), received, received ? person[s.staff] : null, received ? s.storage || null : null, s.hidden || null]);
    await log(reporter, id, null, s.received === false || PEOPLE.find((p) => p[0] === reporter)[3] === 'member' ? 'found_reported' : 'found_logged', s.name, at(s.ago, 15));
    if (received && PEOPLE.find((p) => p[0] === reporter)[3] === 'member') await log(s.staff, id, null, 'found_received', s.storage, received);
    return id;
  }
  async function confirmMatch(lostId, foundId, who, daysAgo) {
    await q(`INSERT INTO matches (lost_item_id, found_item_id, match_date, score, match_status, decided_by, decided_at) VALUES (?, ?, ?, 85, 'confirmed', ?, ?)
      ON DUPLICATE KEY UPDATE match_status = 'confirmed', decided_by = VALUES(decided_by), decided_at = VALUES(decided_at)`, [lostId, foundId, at(daysAgo + 0.5), person[who], at(daysAgo, 11)]);
    await log(who, foundId, null, 'match_confirmed', `lost item ${lostId}`, at(daysAgo, 11));
  }
  async function claim(owner, foundId, s) {
    await q('INSERT IGNORE INTO owners (person_id) VALUES (?)', [person[owner]]);
    const id = await ins(`INSERT INTO claims (lost_item_id, found_item_id, owner_id, claim_status_id, claim_date, proof_description, reviewed_by, reviewed_at, decision_notes, approved_flag, restitution_date, released_by, id_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [s.lost || null, foundId, person[owner], status[s.status], at(s.ago, 12), s.proof,
      s.by ? person[s.by] : null, s.decided != null ? at(s.decided, 14) : null, s.notes || null, ['approved', 'returned'].includes(s.status) ? 1 : null,
      s.returned != null ? at(s.returned, 11) : null, s.returned != null ? person[s.by] : null, s.returned != null]);
    await log(owner, foundId, id, 'claim_submitted', null, at(s.ago, 12));
    if (s.decided != null) await log(s.by, foundId, id, s.status === 'rejected' ? 'claim_rejected' : 'claim_approved', s.notes, at(s.decided, 14));
    if (s.returned != null) await log(s.by, foundId, id, 'item_returned', 'ID checked', at(s.returned, 11));
    return id;
  }

  // 1. Thandi's wallet: found by Sipho, matched, claimed and returned.
  const wallet = await lost('thandi', { name: 'Black leather wallet', cat: 'Wallets and purses', desc: 'Black leather wallet with a red stripe on the side. My student card and two bank cards are inside.', colour: 'Black', brand: 'Guess', city: 'Mthatha', place: 'Taxi rank next to Riverside Mall', ago: 6, status: 'returned' });
  const walletF = await found('sipho', { name: 'Black wallet with red stripe', cat: 'Wallets and purses', desc: 'Black leather wallet found on a bench in the food court.', colour: 'black', city: 'Mthatha', place: 'Riverside Mall food court', ago: 5, office: 'Riverside Mall', staff: 'sizwe', storage: 'Safe, envelope 12', status: 'returned', hidden: 'Student card: T. Mokoena. FNB card ending 4411. R50 note.' });
  await confirmMatch(wallet, walletF, 'sizwe', 4.6);
  await claim('thandi', walletF, { lost: wallet, status: 'returned', ago: 4.5, by: 'sizwe', decided: 4, returned: 3, notes: 'Name on the student card and the card number match.', proof: 'My student card (Thandi Mokoena) is inside, an FNB card ending in 4411 and a R50 note.' });

  // 2. Ayanda's phone: handed in at the police station; a suggestion to review; a false claim rejected; Ayanda's claim pending.
  const phone = await lost('ayanda', { name: 'Samsung Galaxy A15', cat: 'Phones', desc: 'Black Samsung Galaxy A15 in a clear cover, cracked screen protector.', colour: 'Black', brand: 'Samsung', city: 'Mthatha', place: 'Sutherland Street bus stop', ago: 3 });
  const phoneF = await found('lindiwe', { name: 'Samsung phone, cracked screen', cat: 'Phones', desc: 'Black Samsung phone in a clear cover, screen protector cracked. Handed in by a taxi driver.', colour: 'Black', brand: 'Samsung', city: 'Mthatha', place: 'Mthatha taxi rank', ago: 2, office: 'Mthatha Central Police Station', staff: 'lindiwe', storage: 'Property room, shelf 3', hidden: 'Lock screen photo: a girl with a brown dog. Sticker of a sunflower inside the cover.' });
  await claim('lwazi', phoneF, { status: 'rejected', ago: 1.8, by: 'lindiwe', decided: 1.5, notes: 'Could not describe the lock screen or the sticker.', proof: 'It is my Samsung phone, I lost it last week in town near the taxis.' });
  await claim('ayanda', phoneF, { lost: phone, status: 'pending', ago: 0.5, proof: 'My lock screen is a photo of my little sister with our dog Bruno, and there is a sunflower sticker inside the clear cover.' });

  // 3. Lerato's car keys: still missing.
  await lost('lerato', { name: 'Toyota car keys', cat: 'Keys', desc: 'Toyota remote key with two house keys on a blue lanyard.', colour: 'Blue', brand: 'Toyota', city: 'East London', place: 'Quigney beachfront', ago: 10 });

  // 4. Suitcase at the airport: Zanele's claim is being checked.
  const suitcase = await found('ayesha', { name: 'Blue hard-shell suitcase', cat: 'Bags', desc: 'Medium blue hard-shell suitcase left at the baggage carousel.', colour: 'Blue', brand: 'Samsonite', city: 'East London', place: 'Baggage carousel 2', ago: 4, office: 'Eastern Cape Regional Airport', staff: 'ayesha', storage: 'Lost property room, rack B', hidden: 'Combination lock 0-4-7. Yellow ribbon on the handle. Clothes and a graduation gown inside.' });
  await claim('zanele', suitcase, { status: 'under_review', ago: 2, proof: 'Blue Samsonite with a yellow ribbon on the handle. Inside are my clothes and my graduation gown. The lock code is 047.' });

  // 5. Glasses at Buffalo City Mall: a second false claim by Lwazi (rejected) — he is now flagged.
  const glasses = await found('pieter', { name: 'Prescription glasses in a brown case', cat: 'Glasses', desc: 'Brown-framed prescription glasses in a hard brown case.', colour: 'Brown', city: 'East London', place: 'Cinema, row F', ago: 8, office: 'Buffalo City Mall', staff: 'pieter', storage: 'Drawer 1', hidden: 'Optometrist label inside the case: Spec-Savers Vincent.' });
  await claim('lwazi', glasses, { status: 'rejected', ago: 6, by: 'pieter', decided: 5, notes: 'Could not name the optometrist on the case.', proof: 'Those are my glasses, brown ones, I lost them at the mall.' });

  // 6. Johan's backpack: matched and approved, waiting to be collected.
  const backpack = await lost('johan', { name: 'Green North Face backpack', cat: 'Bags', desc: 'Green North Face backpack with a laptop sleeve and a water bottle.', colour: 'Green', brand: 'The North Face', city: 'East London', place: 'Buffalo City Mall parking', ago: 12, status: 'claimed' });
  const backpackF = await found('pieter', { name: 'Green backpack', cat: 'Bags', desc: 'Green North Face backpack found in the parking garage.', colour: 'green', brand: 'The North Face', city: 'East London', place: 'Parking level 2', ago: 11, office: 'Buffalo City Mall', staff: 'pieter', storage: 'Store room, shelf A4', status: 'claimed', hidden: 'Name tag inside: J. Botha. Dell laptop charger and a steel water bottle.' });
  await confirmMatch(backpack, backpackF, 'pieter', 10.5);
  await claim('johan', backpackF, { lost: backpack, status: 'approved', ago: 10, by: 'pieter', decided: 9, notes: 'Name tag matches.', proof: 'There is a name tag J. Botha inside, a Dell laptop charger and a steel water bottle.' });

  // 7. A bracelet Sipho will hand in (not received yet).
  await found('sipho', { name: 'Silver bracelet', cat: 'Jewellery and watches', desc: 'Thin silver chain bracelet with a small heart charm.', colour: 'Silver', city: 'Mthatha', place: 'Parking lot outside the clinic', ago: 1, office: 'Riverside Mall', received: false, hidden: 'Engraving on the heart: "N.M. 2021".' });

  // 8. An ID document handed to Home Affairs after 30 days (closed).
  const idDoc = await found('lindiwe', { name: 'Green ID book', cat: 'ID and documents', desc: 'South African green ID book found in a shopping trolley.', colour: 'Green', city: 'Mthatha', ago: 40, office: 'Mthatha Central Police Station', staff: 'lindiwe', storage: 'Documents file', status: 'closed', hidden: 'Name and ID number on page 1.' });
  await log('lindiwe', idDoc, null, 'item_closed', 'Not claimed in 30 days; sent to Home Affairs', at(9, 9));

  // 9. Zanele's earrings: closed by her.
  const earrings = await lost('zanele', { name: 'Gold hoop earrings', cat: 'Jewellery and watches', desc: 'Pair of small gold hoop earrings in a red pouch.', colour: 'Gold', city: 'East London', ago: 20, status: 'closed' });
  await log('zanele', earrings, null, 'item_closed', 'Found them at home', at(18));

  // 10. A laptop bag returned to Lerato.
  const laptop = await found('ayesha', { name: 'Black Lenovo laptop bag', cat: 'Electronics', desc: 'Black laptop bag with a Lenovo laptop inside, left at security.', colour: 'Black', brand: 'Lenovo', city: 'East London', place: 'Security check', ago: 25, office: 'Eastern Cape Regional Airport', staff: 'ayesha', storage: 'Lost property room, rack A', status: 'returned', hidden: 'Laptop serial PF2X91. University sticker on the lid.' });
  await claim('lerato', laptop, { status: 'returned', ago: 24, by: 'ayesha', decided: 24, returned: 23, notes: 'Serial number matches.', proof: 'My Lenovo ThinkPad, serial number PF2X91, with a university sticker on the lid.' });

  // 11-14. More open items on the board.
  await found('sizwe', { name: "Child's school jersey", cat: 'Clothing', desc: 'Navy school jersey, size 10, with a crest.', colour: 'Navy', city: 'Mthatha', place: 'Play area', ago: 2, office: 'Riverside Mall', staff: 'sizwe', storage: 'Clothing box', hidden: 'Name written on the label: "Amahle".' });
  await lost('thandi', { name: 'Student card', cat: 'ID and documents', desc: 'University student card with my photo, on a red lanyard.', colour: 'Red', city: 'Mthatha', place: 'Campus library', ago: 1, office: 'Mthatha Central Police Station' });
  await found('lindiwe', { name: 'Brown wallet with bank cards', cat: 'Wallets and purses', desc: 'Brown leather wallet with bank cards, no cash.', colour: 'Brown', city: 'Gqeberha', ago: 30, office: 'Gqeberha Harbour Police Station', staff: 'lindiwe', storage: 'Safe', hidden: 'Capitec card ending 2290.' });
  await found('pieter', { name: 'Black umbrella', cat: 'Other', desc: 'Large black golf umbrella with a wooden handle.', colour: 'Black', city: 'East London', place: 'Main entrance', ago: 3, office: 'Buffalo City Mall', staff: 'pieter', storage: 'Umbrella stand' });
  await found('ayesha', { name: 'AirPods in a white case', cat: 'Electronics', desc: 'Apple AirPods in a white charging case.', colour: 'White', brand: 'Apple', city: 'East London', place: 'Gate 3 seating', ago: 1, office: 'Eastern Cape Regional Airport', staff: 'ayesha', storage: 'Electronics drawer', hidden: 'Case engraved "Kea".' });

  // Let the system suggest matches between the open items.
  const conn = await pool.getConnection();
  try {
    const [open] = await conn.query("SELECT id FROM items WHERE status IN ('open', 'matched') AND date_reported > NOW() - INTERVAL 60 DAY");
    for (const i of open) await suggestMatches(conn, i.id);
  } finally { conn.release(); }

  console.log('Sample data created. Log in with any of these usernames and the password in tools/sample-data.js:');
  console.log(PEOPLE.map(([u, f, l, r, o]) => `  ${u.padEnd(8)} ${f} ${l} (${r}${o ? `, ${o}` : ''})`).join('\n'));
  return { person, office, items: { wallet, walletF, phone, phoneF, suitcase, glasses, backpack, backpackF } };
}

module.exports = { seed, clean, PASSWORD, BASE };

if (require.main === module) {
  const action = process.argv[2];
  (action === 'seed' ? seed() : action === 'clean' ? clean() : Promise.reject(new Error('Usage: node tools/sample-data.js seed|clean')))
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
