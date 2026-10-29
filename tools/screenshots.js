// Takes screenshots of every main screen for the user manual.
// Self-contained: creates the fictional sample data from tools/sample-data.js (people use the
// sample.test email domain), takes the screenshots, then deletes everything it created.
// Dialogs are only opened and filled in for the picture; nothing is submitted.
// Needs the app running (npm start).
// Usage: node tools/screenshots.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { seed, clean, PASSWORD, BASE } = require('./sample-data');
const { launch } = require('./render');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const data = await seed();
  const { person, items } = data;
  const claimOf = async (owner, foundId) => (await pool.query('SELECT id FROM claims WHERE owner_id = ? AND found_item_id = ?', [person[owner], foundId]))[0][0].id;
  const ayandaClaim = await claimOf('ayanda', items.phoneF);
  const johanClaim = await claimOf('johan', items.backpackF);
  const [[jersey]] = await pool.query("SELECT id FROM items WHERE item_name = ? ORDER BY id DESC LIMIT 1", ["Child's school jersey"]);
  const [[bracelet]] = await pool.query("SELECT id FROM items WHERE item_name = 'Silver bracelet' ORDER BY id DESC LIMIT 1");

  const browser = await launch();
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  page.on('dialog', (d) => d.accept());
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const go = (url) => page.goto(`${BASE}/${url}`, { waitUntil: 'networkidle2', timeout: 60000 });

  async function login(who) {
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' })).catch(() => {});
    await go('').catch(() => go(''));
    await page.waitForSelector('#login-username');
    await page.type('#login-username', who);
    await page.type('#login-password', PASSWORD);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#login-form button')]);
  }
  // Opens a page, waits for its data, optionally prepares it, then saves the screenshot.
  async function shot(name, url, prepare, { wait = 1200 } = {}) {
    if (url) await go(url);
    await pause(wait);
    if (prepare) { await prepare(); await pause(600); }
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  ', name);
  }
  const scrollTo = (selector, offset = 16) => page.evaluate((s, o) => {
    document.querySelector(s).scrollIntoView({ block: 'start' });
    window.scrollBy(0, -o);
  }, selector, offset);
  const scrollToText = (tag, text, offset = 16) => page.evaluate((t, x, o) => {
    const el = [...document.querySelectorAll(t)].find((e) => e.textContent.includes(x));
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -o);
  }, tag, text, offset);
  async function selectByText(sel, label) {
    await page.waitForFunction((s) => document.querySelector(s)?.options.length > 1, {}, sel);
    const value = await page.$eval(sel, (el, l) => [...el.options].find((o) => o.text.includes(l)).value, label);
    await page.select(sel, value);
  }
  const clickTab = (tab) => page.click(`#tabs [data-tab="${tab}"]`);

  try {
    // ---------- getting started
    await go('');
    await shot('01-login', null);
    await shot('02-register', null, async () => {
      await page.click('#tab-register');
      await page.type('#reg-first', 'Nosipho');
      await page.type('#reg-last', 'Bele');
      await page.type('#reg-username', 'nosipho.b');
      await page.type('#reg-email', 'nosipho@sample.test');
      await page.type('#reg-phone', '071 555 0199');
      await page.type('#reg-number', '14');
      await page.type('#reg-street', 'Owen Street');
      await selectByText('#reg-province', 'Eastern Cape');
      await selectByText('#reg-city', 'Mthatha');
    });

    // ---------- member
    await login('thandi');
    await shot('03-dashboard-member', 'dashboard.html');
    await shot('04-browse', 'browse.html');
    await shot('05-search', 'browse.html?q=wallet', async () => { await page.select('#status', 'all'); });
    await shot('06-report-lost', 'report.html?type=lost', async () => {
      await page.type('#item-name', 'Silver Casio watch');
      await selectByText('#category', 'Jewellery and watches');
      await page.type('#description', 'Silver Casio digital watch with a metal strap. One link of the strap is a different colour.');
      await page.type('#colour', 'Silver');
      await page.type('#brand', 'Casio');
      await page.type('#place', 'Riverside Mall, near the cinema');
      await page.evaluate(() => scrollTo(0, 0));
    });
    await shot('07-report-found', 'report.html?type=found', async () => {
      await page.type('#item-name', 'Blue umbrella');
      await selectByText('#category', 'Other');
      await page.type('#description', 'Small blue folding umbrella in a black sleeve.');
      await page.type('#colour', 'Blue');
      await selectByText('#office', 'Riverside Mall');
      await page.type('#hidden', 'Name written on the inside of the sleeve: "Lulu".');
      await scrollTo('#where-legend', 40);
    });
    await shot('08-item-member', `item.html?id=${jersey.id}`);
    await shot('09-claim-dialog', `item.html?id=${jersey.id}`, async () => {
      await page.waitForSelector('#claim');
      await page.click('#claim');
      await page.waitForSelector('#claim-dialog[open]');
      await page.type('#c-proof', 'It is my son\'s jersey. His name, Amahle, is written on the label inside the collar.');
    });
    await shot('10-lost-item-returned', `item.html?id=${items.wallet}`);
    await shot('11-profile', 'profile.html');

    // ---------- office admin
    await login('lindiwe');
    await shot('15-dashboard-staff', 'dashboard.html');
    await shot('16-item-staff', `item.html?id=${items.phoneF}`);
    await shot('17-item-staff-claims', `item.html?id=${items.phoneF}`, async () => { await scrollToText('h2', 'Claims'); });
    await shot('18-matches', 'matches.html');
    await shot('19-claims-staff', 'claims.html?status=');
    await shot('20-claim-staff', `claim.html?id=${ayandaClaim}`);
    await shot('21-approve-dialog', `claim.html?id=${ayandaClaim}`, async () => {
      await page.waitForSelector('#approve');
      await page.click('#approve');
      await page.waitForSelector('#decide-dialog[open]');
      await page.type('#d-notes', 'Lock screen photo and sunflower sticker match.');
    });
    await shot('22-log-found', 'report.html?type=found', async () => {
      await page.type('#item-name', 'Brown leather handbag');
      await selectByText('#category', 'Bags');
      await page.type('#description', 'Brown leather handbag with a gold clasp, handed in by a taxi marshal.');
      await page.type('#colour', 'Brown');
      await selectByText('#province', 'Eastern Cape');
      await selectByText('#city', 'Mthatha');
      await selectByText('#office', 'Mthatha Central');
      await page.type('#hidden', 'Clinic card inside: N. Sithole. Lipstick and a blue purse.');
      await page.type('#storage', 'Property room, shelf 1');
      await scrollTo('#where-legend', 40);
    });
    await shot('23-reports-office', 'reports.html', null, { wait: 1800 });
    await shot('24-offices-office', 'offices.html', async () => { await page.waitForSelector('#admins tr'); await scrollTo('#manage', 24); }, { wait: 1500 });
    await login('sizwe');
    await shot('25-receive-dialog', `item.html?id=${bracelet.id}`, async () => {
      await page.waitForSelector('#receive');
      await page.click('#receive');
      await page.waitForSelector('#receive-dialog[open]');
      await page.type('#r-storage', 'Safe, envelope 15');
    });
    await login('pieter');
    await shot('26-return-dialog', `claim.html?id=${johanClaim}`, async () => {
      await page.waitForSelector('#return');
      await page.click('#return');
      await page.waitForSelector('#return-dialog[open]');
      await page.click('#ret-id');
      await page.type('#ret-notes', 'ID book checked, collected in person.');
    });

    // ---------- the owner after the office confirmed the match (done here so the staff shots still show it to review)
    await pool.query("UPDATE matches SET match_status = 'confirmed', decided_by = ?, decided_at = NOW() WHERE lost_item_id = ? AND found_item_id = ?", [person.lindiwe, items.phone, items.phoneF]);
    await pool.query("UPDATE items SET status = 'matched' WHERE id IN (?, ?)", [items.phone, items.phoneF]);
    await login('ayanda');
    await shot('12-dashboard-match', 'dashboard.html');
    await shot('13-my-claims', 'claims.html');
    await shot('14-claim-member', `claim.html?id=${ayandaClaim}`);

    // ---------- system admin
    await login('nomvula');
    await shot('27-dashboard-admin', 'dashboard.html');
    await shot('28-offices-admin', 'offices.html', () => page.waitForSelector('#list .tag-card'));
    await shot('29-office-form', 'offices.html', async () => {
      await page.click('#add');
      await page.waitForSelector('#dialog[open]');
      await page.type('#f-name', 'Mthatha Airport');
      await page.select('#f-type', 'airport');
      await page.evaluate(() => document.getElementById('f-type').dispatchEvent(new Event('change')));
      await page.type('#f-email', 'lostproperty@mthatha-airport.test');
      await page.type('#f-phone', '047 555 0600');
      await page.type('#f-hours', 'Daily 06:00–20:00');
      await page.type('#f-iata', 'UTT');
      await page.type('#f-terminal', 'Main terminal');
      await page.type('#f-number', '1');
      await page.type('#f-street', 'Airport Road');
      await selectByText('#f-province', 'Eastern Cape');
      await selectByText('#f-city', 'Mthatha');
    });
    await shot('30-admin-people', 'admin.html', async () => {
      await page.type('#p-first', 'Bongani');
      await page.type('#p-last', 'Zulu');
      await page.type('#p-email', 'bongani@sample.test');
      await selectByText('#p-office', 'Gqeberha Harbour');
    });
    await shot('31-admin-locations', 'admin.html', async () => { await clickTab('locations'); await page.waitForSelector('#cities tr'); });
    await shot('32-admin-categories', 'admin.html', async () => { await clickTab('categories'); await page.waitForSelector('#categories tr'); });
    await shot('33-admin-statuses', 'admin.html', async () => { await clickTab('statuses'); await page.waitForSelector('#statuses tr'); });
    await shot('34-admin-activity', 'admin.html', async () => { await clickTab('activity'); await page.waitForSelector('#activity li'); });
    await shot('35-reports-admin', 'reports.html', async () => { await scrollToText('h2', 'By category', 90); }, { wait: 1800 });

    // ---------- on a phone
    await login('thandi');
    page = await browser.newPage(); // a fresh tab, so the phone size applies from the first paint
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await shot('36-phone-dashboard', 'dashboard.html');
    await shot('37-phone-item', `item.html?id=${jersey.id}`);
  } finally {
    await browser.close();
    await clean();
    await pool.end();
  }
  console.log(`Screenshots saved to ${OUT}. Sample data removed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
