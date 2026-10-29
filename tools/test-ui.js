// Browser tests: drives the real pages in Microsoft Edge (headless) the way people use them:
// register, report a lost item, report a found item with a private photo and secret details,
// receive it and confirm the match as office staff, claim it as the owner, approve and hand it
// over, and check what each role may see, including on a phone-sized screen.
// Self-contained: creates its own office and staff accounts, and removes everything at the end
// (even if a test fails). Needs the app running (npm start).
// Usage: node tools/test-ui.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { launch } = require('./render');

const BASE = `http://localhost:${process.env.PORT || 3005}`;
const tag = Date.now().toString(36).toLowerCase().slice(-6);
const emailFor = (who) => `${who}.${tag}@uitest.test`;
const userFor = (who) => `${who}.${tag}`;
const PASSWORD = 'Test-pass-123';
const PHOTO = path.join(os.tmpdir(), `lf-ui-${tag}.png`);
fs.writeFileSync(PHOTO, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const OFFICE = `UI Desk ${tag}`;
const ITEM = `Blue Nokia phone ${tag}`;
const SECRET = `Lock screen shows a lighthouse ${tag}`;

const results = [];
let check = function (area, name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const ids = { office: null, address: null, lost: null, found: null, claim: null };

async function setUp() {
  const [[city]] = await pool.query("SELECT id FROM cities WHERE name = 'Mthatha'");
  const [a] = await pool.query("INSERT INTO addresses (city_id, street_number, street_name) VALUES (?, '5', 'Sutherland Street')", [city.id]);
  ids.address = a.insertId;
  const [o] = await pool.query("INSERT INTO lost_found_offices (address_id, name, email, phone, lfo_type) VALUES (?, ?, 'desk@uitest.test', '047 555 0100', 'mall')", [a.insertId, OFFICE]);
  ids.office = o.insertId;
  await pool.query("INSERT INTO shopping_malls (lfo_id, desk_location) VALUES (?, 'Ground floor, next to the food court')", [o.insertId]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const [who, first, role] of [['sysadmin', 'Sys', 'system_admin'], ['staff', 'Desk', 'office_admin'], ['finder', 'Finn', 'member']]) {
    const [p] = await pool.query('INSERT INTO persons (first_name, last_name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [first, 'Tester', userFor(who), emailFor(who), hash, role]);
    if (who === 'staff') await pool.query('INSERT INTO it_admins (lfo_id, person_id) VALUES (?, ?)', [o.insertId, p.insertId]);
  }
}

async function main() {
  await setUp();
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('dialog', (d) => d.accept());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const has = async (s, timeout = 8000) => { try { await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t), { timeout }, s.toLowerCase()); return true; } catch { return false; } };
    const lacks = async (s, timeout = 4000) => { try { await page.waitForFunction((t) => !document.body.innerText.toLowerCase().includes(t), { timeout }, s.toLowerCase()); return true; } catch { return false; } };
    const go = (url) => page.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 60000 });
    const settle = (url) => page.waitForFunction((u) => location.href.includes(u), { timeout: 10000 }, url).then(() => true, () => false);
    const waitOptions = (sel) => page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).options.length > 1, { timeout: 8000 }, sel);
    async function selectByText(sel, label) {
      await waitOptions(sel);
      const value = await page.$eval(sel, (el, l) => [...el.options].find((o) => o.text.includes(l))?.value, label);
      await page.select(sel, value);
    }
    async function fill(sel, value) {
      await page.$eval(sel, (el) => { el.value = ''; });
      await page.type(sel, String(value));
    }
    async function login(who, password = PASSWORD) {
      // Log out first: index.html sends logged-in people to their dashboard.
      await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' })).catch(() => {});
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 })
        .catch(() => page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60000 }));
      await page.waitForSelector('#login-username');
      await page.type('#login-username', who);
      await page.type('#login-password', password);
      if (password !== PASSWORD) { await page.click('#login-form button'); return; } // a failed login stays on the page
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#login-form button')]);
    }
    const idFromUrl = () => Number(new URL(page.url()).searchParams.get('id'));
    if (process.env.UI_DEBUG) {
      const plain = check;
      check = async (...a) => { plain(...a); if (!a[2]) console.log('   at', page.url(), '\n  ', (await page.evaluate(() => document.body.innerText)).slice(0, 600).replace(/\s+/g, ' ')); };
    }

    // ---------- access without logging in ----------
    await go('dashboard.html');
    check('Access', 'A page opened without logging in goes back to the login screen', await settle('/index.html') || new URL(page.url()).pathname === '/');

    // ---------- registration ----------
    await go('');
    await page.click('#tab-register');
    await page.type('#reg-first', 'Olwethu');
    await page.type('#reg-last', 'Owner');
    await page.type('#reg-username', userFor('owner'));
    await page.type('#reg-email', emailFor('owner'));
    await page.type('#reg-password', PASSWORD);
    await page.type('#reg-phone', '082 555 0101');
    await page.type('#reg-number', '12');
    await page.type('#reg-street', 'Nelson Mandela Drive');
    await selectByText('#reg-province', 'Eastern Cape');
    await selectByText('#reg-city', 'Mthatha');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#register-form button[type=submit]')]);
    check('Register', 'A new member registers and lands on "My items"', page.url().includes('dashboard.html') && await has('Olwethu Owner'));

    await login(userFor('owner'), 'wrong-password-1');
    check('Login', 'A wrong password shows an error and stays on the login screen',
      await page.waitForFunction(() => document.getElementById('login-error').textContent.trim().length > 0, { timeout: 8000 }).then(() => true, () => false));

    // ---------- the owner reports a lost item ----------
    await login(userFor('owner'));
    await go('report.html?type=lost');
    await page.waitForSelector('#item-name');
    check('Report lost', 'The lost form asks for the date it was lost', await has('Date you lost it'));
    await page.type('#item-name', ITEM);
    await selectByText('#category', 'Phones');
    await page.type('#description', 'Blue Nokia phone in a cracked black cover, small scratch on the back.');
    await page.type('#colour', 'Blue');
    await page.type('#brand', 'Nokia');
    await waitOptions('#city');
    check('Report lost', 'The city is filled in from the member\'s address', await page.$eval('#city', (el) => el.options[el.selectedIndex].text.includes('Mthatha')));
    await page.type('#place', 'Taxi rank, Sutherland Street');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#submit')]);
    ids.lost = idFromUrl();
    check('Report lost', 'The report is saved and shows its reference', await has('your report was saved as') && await has('L-0'));
    await go('dashboard.html');
    check('Report lost', '"My items" lists the new lost report', await has(ITEM));

    // ---------- another member reports the found item with a private photo ----------
    await login(userFor('finder'));
    await go('report.html?type=found');
    await page.waitForSelector('#item-name');
    check('Report found', 'The found form has the secret details box', await page.$eval('#found-extra', (el) => !el.classList.contains('hidden')));
    await page.type('#item-name', ITEM);
    await selectByText('#category', 'Phones');
    await page.type('#description', 'Blue Nokia phone with a black cover, found on a bench.');
    await page.type('#colour', 'Blue');
    await selectByText('#province', 'Eastern Cape');
    await selectByText('#city', 'Mthatha');
    await selectByText('#office', OFFICE);
    await page.type('#hidden', SECRET);
    const input = await page.$('#photos');
    await input.uploadFile(PHOTO);
    await page.waitForSelector('[data-private="0"]');
    await page.click('[data-private="0"]');
    check('Report found', 'The photo preview shows with a "private" tick box', await page.$eval('[data-private="0"]', (el) => el.checked));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#submit')]);
    ids.found = idFromUrl();
    check('Report found', 'The finder is asked to hand the item in at the office', await has(`Please hand the item in at ${OFFICE}`));
    check('Report found', 'The system found the lost report as a possible match', await has('possible match'));
    check('Report found', 'It shows "Not handed in yet"', await has('Not handed in yet'));

    // ---------- office staff receive the item and confirm the match ----------
    await login(userFor('staff'));
    check('Office', 'Office staff land on the dashboard with the office name in the header', page.url().includes('dashboard.html') && await has(OFFICE));
    await go(`item.html?id=${ids.found}`);
    await page.waitForSelector('#receive');
    check('Office', 'Staff see the secret details', await has(SECRET));
    check('Office', 'Staff see the private photo', await page.$$eval('.photos img', (imgs) => imgs.length) === 1);
    await page.click('#receive');
    await page.type('#r-storage', 'Shelf B2');
    await page.click('#receive-form button[type=submit]');
    check('Office', 'Marking the item handed in records it at the office', await has('Marked as handed in') && await lacks('Not handed in yet'));
    check('Office', 'The lost report is listed as a possible match', await has(`${ITEM}`) && !!await page.$('[data-confirm]'));
    await page.click('[data-confirm]');
    check('Office', 'Confirming the match tells staff the owner can claim', await has('Match confirmed'));

    // ---------- the owner finds it with the search box and claims it ----------
    await login(userFor('owner'));
    await page.waitForSelector('.search input'); // the header is drawn once the page knows who is logged in
    await page.type('.search input', tag);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.keyboard.press('Enter')]);
    check('Browse', 'The header search box finds the item', page.url().includes('browse.html') && await has(ITEM));
    await go(`item.html?id=${ids.found}`);
    await page.waitForSelector('#claim');
    check('Privacy', 'A member does not see the secret details', await lacks(SECRET));
    check('Privacy', 'A member does not see the private photo', await page.$$eval('.photos img', (imgs) => imgs.length) === 0);
    await page.click('#claim');
    await waitOptions('#c-lost');
    check('Claim', 'The claim form links the owner\'s matched lost report', await page.$eval('#c-lost', (el) => Number(el.value)) === ids.lost);
    await page.type('#c-proof', 'The lock screen picture is a lighthouse and there is a scratch on the back.');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#claim-form button[type=submit]')]);
    ids.claim = idFromUrl();
    check('Claim', 'The claim is sent and its page explains the next step', await has('Your claim was sent') && await has('The office will check'));

    // ---------- staff approve and hand it over ----------
    await login(userFor('staff'));
    await go(`claim.html?id=${ids.claim}`);
    await page.waitForSelector('#approve');
    check('Decide', 'Staff compare the claim with the secret details', await has(SECRET) && await has('lighthouse and there is a scratch'));
    await page.click('#approve');
    await page.click('#d-submit');
    check('Decide', 'Approving the claim', await has('Claim approved'));
    await page.waitForSelector('#return');
    await page.click('#return');
    await page.click('#return-form button[type=submit]');
    check('Decide', 'Handing over without checking the ID is refused',
      await page.waitForFunction(() => document.getElementById('ret-error').textContent.trim().length > 0, { timeout: 8000 }).then(() => true, () => false));
    await page.click('#ret-id');
    await page.click('#return-form button[type=submit]');
    check('Decide', 'With the ID checked, the item is handed over', await has('Item handed over to its owner'));

    await login(userFor('owner'));
    await go(`claim.html?id=${ids.claim}`);
    check('Claim', 'The owner sees the item was collected', await has('You collected your item'));
    await go(`item.html?id=${ids.lost}`);
    check('Claim', 'The owner\'s lost report shows "Returned"', await has('Returned'));

    // ---------- what each role may open ----------
    await go('reports.html');
    check('Access', 'A member opening Reports is sent to their own page', await settle('dashboard.html'));
    await go('admin.html');
    check('Access', 'A member opening Admin is sent to their own page', await settle('dashboard.html'));
    await login(userFor('staff'));
    await go('admin.html');
    check('Access', 'Office staff opening Admin are sent to the dashboard', await settle('dashboard.html'));
    await go('reports.html');
    check('Reports', 'Office staff see the reports for their office', await has(`at ${OFFICE}`) && await has('Possible fraud'));
    await login(userFor('sysadmin'));
    await go('admin.html');
    check('Access', 'The system admin opens Admin', page.url().includes('admin.html') && await has('Admin'));
    await go('reports.html');
    check('Reports', 'The system admin can filter reports by province, city or office', await page.$eval('#area', (el) => !el.classList.contains('hidden')));

    // ---------- profile ----------
    await login(userFor('owner'));
    await go('profile.html');
    await page.waitForSelector('#phone');
    await waitOptions('#city');
    await fill('#phone', '082 555 0199');
    await page.click('#details-form button[type=submit]');
    await new Promise((r) => setTimeout(r, 800));
    const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()));
    check('Profile', 'A member changes their phone number', me.phone === '082 555 0199');

    // ---------- phone-sized screen ----------
    await page.setViewport({ width: 375, height: 812, isMobile: true });
    const wide = [];
    for (const url of ['dashboard.html', 'browse.html', `item.html?id=${ids.found}`, 'report.html?type=lost', 'claims.html', `claim.html?id=${ids.claim}`, 'offices.html', 'profile.html']) {
      await go(url);
      await new Promise((r) => setTimeout(r, 600));
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) wide.push(url);
    }
    check('Phone', 'Member pages fit a 375px phone screen without sideways scrolling', wide.length === 0, wide.join(', '));
    await login(userFor('staff'));
    const wideStaff = [];
    for (const url of ['dashboard.html', 'matches.html', 'reports.html', `claim.html?id=${ids.claim}`]) {
      await go(url);
      await new Promise((r) => setTimeout(r, 600));
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) wideStaff.push(url);
    }
    check('Phone', 'Staff pages fit a 375px phone screen', wideStaff.length === 0, wideStaff.join(', '));

    check('Pages', 'No JavaScript errors on any page', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
}

async function cleanUp() {
  const like = `%.${tag}@uitest.test`;
  const [people] = await pool.query('SELECT id, address_id FROM persons WHERE email LIKE ?', [like]);
  const personIds = people.map((p) => p.id).concat([0]);
  const officeIds = [ids.office || 0];
  const [items] = await pool.query(`SELECT i.id FROM items i LEFT JOIN lost_items l ON l.item_id = i.id LEFT JOIN found_items f ON f.item_id = i.id
    WHERE l.owner_id IN (?) OR l.reporter_id IN (?) OR f.reporter_id IN (?) OR f.lfo_id IN (?) OR l.lfo_id IN (?) OR i.item_name = ?`,
  [personIds, personIds, personIds, officeIds, officeIds, ITEM]);
  const itemIds = items.map((i) => i.id).concat([0]);
  await pool.query('DELETE FROM activity_log WHERE person_id IN (?) OR item_id IN (?) OR claim_id IN (SELECT id FROM claims WHERE found_item_id IN (?))', [personIds, itemIds, itemIds]);
  await pool.query('DELETE FROM claims WHERE found_item_id IN (?) OR owner_id IN (?)', [itemIds, personIds]);
  await pool.query('DELETE FROM matches WHERE lost_item_id IN (?) OR found_item_id IN (?)', [itemIds, itemIds]);
  await pool.query('DELETE FROM lost_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM found_items WHERE item_id IN (?)', [itemIds]);
  await pool.query('DELETE FROM items WHERE id IN (?)', [itemIds]);
  await pool.query('DELETE FROM it_admins WHERE lfo_id IN (?) OR person_id IN (?)', [officeIds, personIds]);
  await pool.query('DELETE FROM shopping_malls WHERE lfo_id IN (?)', [officeIds]);
  await pool.query('DELETE FROM lost_found_offices WHERE id IN (?)', [officeIds]);
  await pool.query('DELETE FROM persons WHERE id IN (?)', [personIds]);
  const addressIds = people.map((p) => p.address_id).filter(Boolean).concat([ids.address || 0]);
  await pool.query('DELETE FROM addresses WHERE id IN (?)', [addressIds]);
  fs.rmSync(PHOTO, { force: true });
  const [[{ n }]] = await pool.query(`SELECT (SELECT COUNT(*) FROM persons WHERE email LIKE ?) + (SELECT COUNT(*) FROM lost_found_offices WHERE name = ?)
    + (SELECT COUNT(*) FROM items WHERE item_name = ?) AS n`, [like, OFFICE, ITEM]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.stack || err.message); results.push(false); })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} UI tests passed.${clean ? ' All test accounts and data were removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
