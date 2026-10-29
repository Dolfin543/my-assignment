const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireSession, requireLogin } = require('../lib/middleware');
const { readNamesAndEmail, readUsername, toSessionUser } = require('../lib/accounts');
const { fail, date, phone: readPhone, inTransaction } = require('../lib/validate');
const { readAddress, saveAddress, removeAddress } = require('../lib/addresses');

const router = express.Router();

// Starts a fresh session for the person (prevents session fixation).
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = user;
      resolve();
    });
  });
}

function readDob(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = date(value, 'date of birth');
  if (d < '1900-01-01' || new Date(d) > new Date()) fail(400, 'Enter a real date of birth.');
  return d;
}

// Members register themselves. Office admins and system admins are set up by an administrator.
router.post('/register', async (req, res) => {
  const details = readNamesAndEmail(req.body);
  if (details.error) fail(400, details.error);
  const username = readUsername(req.body.username);
  if (!username) fail(400, 'Choose a username of 3–30 letters, digits, dots, dashes or underscores.');
  if (!req.body.password || req.body.password.length < 8) fail(400, 'Password must be at least 8 characters.');
  const phone = readPhone(req.body.phone);
  const dob = readDob(req.body.dob);
  const address = await readAddress(req.body, { optional: true });
  const [[taken]] = await pool.query('SELECT username, email FROM persons WHERE username = ? OR email = ?', [username, details.email]);
  if (taken) fail(409, taken.username === username ? 'That username is taken. Choose another one.' : 'An account with this email already exists.');
  const hash = await bcrypt.hash(req.body.password, 10);

  const user = await inTransaction(async (conn) => {
    const addressId = address ? await saveAddress(conn, null, address) : null;
    const [r] = await conn.query(`INSERT INTO persons (address_id, username, first_name, last_name, dob, email, phone, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [addressId, username, details.firstName, details.lastName, dob, details.email, phone, hash]);
    return toSessionUser({ id: r.insertId, first_name: details.firstName, last_name: details.lastName, username, email: details.email, role: 'member' });
  });
  await logIn(req, user);
  res.status(201).json(user);
});

// Log in with username (or email) and password.
router.post('/login', async (req, res) => {
  const login = String(req.body.username || req.body.email || '').trim().toLowerCase();
  const [[row]] = await pool.query(`SELECT p.*, a.lfo_id AS office_id FROM persons p LEFT JOIN it_admins a ON a.person_id = p.id
    WHERE p.username = ? OR p.email = ?`, [login, login]);
  const ok = row && await bcrypt.compare(String(req.body.password || ''), row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  if (!row.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact the lost-and-found office.' });
  const user = toSessionUser(row);
  await logIn(req, user);
  res.json(user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

// The logged-in person with phone, date of birth, address, owner/reporter codes and office.
router.get('/me', requireSession, async (req, res) => {
  const [[extra]] = await pool.query(`
    SELECT p.phone, p.dob, ad.street_number, ad.street_name, ad.suburb, ad.city_id, ct.province_id,
           o.owner_code, r.reporter_code, lfo.name AS office_name, lfo.lfo_type AS office_type
    FROM persons p
    LEFT JOIN addresses ad ON ad.id = p.address_id
    LEFT JOIN cities ct ON ct.id = ad.city_id
    LEFT JOIN owners o ON o.person_id = p.id
    LEFT JOIN reporters r ON r.person_id = p.id
    LEFT JOIN it_admins ia ON ia.person_id = p.id
    LEFT JOIN lost_found_offices lfo ON lfo.id = ia.lfo_id
    WHERE p.id = ?`, [req.session.user.id]);
  res.json({
    ...req.session.user, phone: extra.phone, dob: extra.dob,
    streetNumber: extra.street_number, streetName: extra.street_name, suburb: extra.suburb, cityId: extra.city_id, provinceId: extra.province_id,
    ownerCode: extra.owner_code, reporterCode: extra.reporter_code, officeName: extra.office_name, officeType: extra.office_type,
  });
});

async function passwordMatches(personId, password) {
  const [[row]] = await pool.query('SELECT password_hash FROM persons WHERE id = ?', [personId]);
  return !!row && bcrypt.compare(String(password || ''), row.password_hash);
}

// Update own details and address.
router.put('/me', requireLogin, async (req, res) => {
  const user = req.session.user;
  const details = readNamesAndEmail(req.body);
  if (details.error) fail(400, details.error);
  const phone = readPhone(req.body.phone);
  const dob = readDob(req.body.dob);
  const address = await readAddress(req.body, { optional: true });
  try {
    await inTransaction(async (conn) => {
      const [[p]] = await conn.query('SELECT address_id FROM persons WHERE id = ? FOR UPDATE', [user.id]);
      const addressId = address ? await saveAddress(conn, p.address_id, address) : null;
      await conn.query('UPDATE persons SET first_name = ?, last_name = ?, email = ?, phone = ?, dob = ?, address_id = ? WHERE id = ?',
        [details.firstName, details.lastName, details.email, phone, dob, addressId, user.id]);
      if (!address) await removeAddress(conn, p.address_id);
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') fail(409, 'Another account already uses this email.');
    throw err;
  }
  res.json({ ok: true });
});

// Change password. Also how someone replaces a temporary password, so it only needs a session.
router.put('/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!await passwordMatches(req.session.user.id, currentPassword)) fail(403, 'Your current password is wrong.');
  if (!newPassword || newPassword.length < 8) fail(400, 'New password must be at least 8 characters.');
  if (newPassword === currentPassword) fail(400, 'Choose a password that is different from the current one.');
  await pool.query('UPDATE persons SET password_hash = ?, must_change_password = FALSE WHERE id = ?',
    [await bcrypt.hash(newPassword, 10), req.session.user.id]);
  req.session.user = { ...req.session.user, mustChangePassword: false };
  res.json(req.session.user);
});

// Delete own account (members only). Their reports and claims stay for the records
// (the owner/reporter link becomes empty); their address is removed.
router.delete('/me', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'member') fail(403, 'Administrator accounts are removed by the system administrator.');
  if (!await passwordMatches(req.session.user.id, req.body.password)) fail(403, 'Your password is wrong.');
  await inTransaction(async (conn) => {
    const [[p]] = await conn.query('SELECT address_id FROM persons WHERE id = ? FOR UPDATE', [req.session.user.id]);
    await conn.query('DELETE FROM persons WHERE id = ?', [req.session.user.id]);
    await removeAddress(conn, p.address_id);
  });
  req.session.destroy(() => res.status(204).end());
});

module.exports = router;
