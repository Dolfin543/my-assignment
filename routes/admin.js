// System administrator: people, locations (provinces and cities), item categories and the
// names of the claim statuses.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');
const { ROLES, makeTempPassword, readNamesAndEmail, readUsername, usernameFromEmail } = require('../lib/accounts');
const { fail, text, optionalText, exists, phone: readPhone, inTransaction } = require('../lib/validate');
const { log } = require('../lib/rules');
const { removeAddress } = require('../lib/addresses');

const router = express.Router();
router.use(requireRole('system_admin'));

// Turns a duplicate-key or still-in-use error into a readable 409.
async function saving(message, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') fail(409, message);
    if (err.code === 'ER_ROW_IS_REFERENCED_2') fail(409, 'This is still in use, so it cannot be deleted.');
    throw err;
  }
}

// ================================================================ people
router.get('/persons', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.search) {
    const like = `%${String(req.query.search).slice(0, 100)}%`;
    where.push("(CONCAT(p.first_name, ' ', p.last_name) LIKE ? OR p.username LIKE ? OR p.email LIKE ?)");
    params.push(like, like, like);
  }
  if (ROLES.includes(req.query.role)) { where.push('p.role = ?'); params.push(req.query.role); }
  const [rows] = await pool.query(`
    SELECT p.id, p.first_name, p.last_name, p.username, p.email, p.phone, p.role, p.is_active, p.must_change_password, p.created_at,
           ia.lfo_id AS office_id, o.name AS office_name, ow.owner_code, rp.reporter_code,
           (SELECT COUNT(*) FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id WHERE c.owner_id = p.id AND s.code = 'rejected') AS rejected_claims,
           (SELECT COUNT(*) FROM lost_items l WHERE l.reporter_id = p.id) + (SELECT COUNT(*) FROM found_items f WHERE f.reporter_id = p.id) AS reports
    FROM persons p
    LEFT JOIN it_admins ia ON ia.person_id = p.id
    LEFT JOIN lost_found_offices o ON o.id = ia.lfo_id
    LEFT JOIN owners ow ON ow.person_id = p.id
    LEFT JOIN reporters rp ON rp.person_id = p.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY FIELD(p.role, 'system_admin', 'office_admin', 'member'), p.first_name, p.last_name LIMIT 500`, params);
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active, must_change_password: !!r.must_change_password })));
});

// Create an account with a temporary password (shown once). An office admin needs an office.
router.post('/persons', async (req, res) => {
  const details = readNamesAndEmail(req.body);
  if (details.error) fail(400, details.error);
  const role = ROLES.includes(req.body.role) ? req.body.role : fail(400, 'Choose a valid role.');
  const officeId = role === 'office_admin' ? await exists('lost_found_offices', req.body.officeId, 'office for the office admin') : null;
  const username = readUsername(req.body.username || usernameFromEmail(details.email));
  if (!username) fail(400, 'The username must be 3–30 letters, digits, dots, dashes or underscores.');
  const tempPassword = makeTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  const id = await saving('That username or email is already used by another account.', () => inTransaction(async (conn) => {
    const [r] = await conn.query(`INSERT INTO persons (first_name, last_name, username, email, phone, password_hash, must_change_password, role)
      VALUES (?, ?, ?, ?, ?, ?, TRUE, ?)`, [details.firstName, details.lastName, username, details.email, readPhone(req.body.phone), hash, role]);
    if (officeId) await conn.query('INSERT INTO it_admins (lfo_id, person_id, added_by) VALUES (?, ?, ?)', [officeId, r.insertId, req.session.user.id]);
    await log(conn, { personId: req.session.user.id, action: 'account_created', details: `${username} (${role})` });
    return r.insertId;
  }));
  res.status(201).json({ id, username, tempPassword });
});

async function findPerson(id) {
  const [[p]] = await pool.query('SELECT * FROM persons WHERE id = ?', [id]);
  if (!p) fail(404, 'Person not found.');
  return p;
}

// Change role, office (office admins) and/or active state. Body: { role?, officeId?, isActive? }
router.patch('/persons/:id', async (req, res) => {
  const person = await findPerson(req.params.id);
  if (person.id === req.session.user.id) fail(400, 'You cannot change your own role or deactivate yourself.');
  const role = req.body.role ?? person.role;
  if (!ROLES.includes(role)) fail(400, 'Choose a valid role.');
  const isActive = req.body.isActive === undefined ? !!person.is_active : !!req.body.isActive;
  await inTransaction(async (conn) => {
    await conn.query('UPDATE persons SET role = ?, is_active = ? WHERE id = ?', [role, isActive, person.id]);
    if (role === 'office_admin') {
      const [[current]] = await conn.query('SELECT lfo_id FROM it_admins WHERE person_id = ?', [person.id]);
      const officeId = req.body.officeId ? await exists('lost_found_offices', req.body.officeId, 'office', { conn }) : current?.lfo_id;
      if (!officeId) fail(400, 'Choose the office this person administers.');
      await conn.query('INSERT INTO it_admins (lfo_id, person_id, added_by) VALUES (?, ?, ?) AS n ON DUPLICATE KEY UPDATE lfo_id = n.lfo_id',
        [officeId, person.id, req.session.user.id]);
    } else {
      await conn.query('DELETE FROM it_admins WHERE person_id = ?', [person.id]);
    }
    await log(conn, { personId: req.session.user.id, action: 'account_changed', details: `${person.username}: ${role}${isActive ? '' : ', deactivated'}` });
  });
  res.json({ id: person.id, role, is_active: isActive });
});

router.post('/persons/:id/reset-password', async (req, res) => {
  const person = await findPerson(req.params.id);
  const tempPassword = makeTempPassword();
  await pool.query('UPDATE persons SET password_hash = ?, must_change_password = TRUE WHERE id = ?', [await bcrypt.hash(tempPassword, 10), person.id]);
  res.json({ tempPassword });
});

// Reports and claims stay (the owner/reporter link becomes empty); the address is removed.
router.delete('/persons/:id', async (req, res) => {
  const person = await findPerson(req.params.id);
  if (person.id === req.session.user.id) fail(400, 'You cannot delete your own account here.');
  await inTransaction(async (conn) => {
    await conn.query('DELETE FROM persons WHERE id = ?', [person.id]);
    await removeAddress(conn, person.address_id);
    await log(conn, { personId: req.session.user.id, action: 'account_deleted', details: person.username });
  });
  res.status(204).end();
});

// ================================================================ provinces and cities
router.post('/provinces', async (req, res) => {
  const [r] = await saving('A province with this name already exists.', () => pool.query('INSERT INTO provinces (name) VALUES (?)', [text(req.body.name, 'The name', 3, 60)]));
  res.status(201).json({ id: r.insertId });
});

router.put('/provinces/:id', async (req, res) => {
  const [r] = await saving('A province with this name already exists.', () => pool.query('UPDATE provinces SET name = ? WHERE id = ?', [text(req.body.name, 'The name', 3, 60), req.params.id]));
  if (!r.affectedRows) fail(404, 'Province not found.');
  res.json({ ok: true });
});

router.delete('/provinces/:id', async (req, res) => {
  const [r] = await saving('', () => pool.query('DELETE FROM provinces WHERE id = ?', [req.params.id]));
  if (!r.affectedRows) fail(404, 'Province not found.');
  res.status(204).end();
});

async function readCity(body) {
  const postalCode = String(body.postalCode || '').trim();
  if (!/^[0-9]{4}$/.test(postalCode)) fail(400, 'The postal code must be 4 digits.');
  return { province_id: await exists('provinces', body.provinceId, 'province'), name: text(body.name, 'The city name', 2, 80), postal_code: postalCode };
}

router.post('/cities', async (req, res) => {
  const data = await readCity(req.body);
  const [r] = await saving('This province already has a city with this name.', () => pool.query('INSERT INTO cities SET ?', [data]));
  res.status(201).json({ id: r.insertId });
});

router.put('/cities/:id', async (req, res) => {
  const data = await readCity(req.body);
  const [r] = await saving('This province already has a city with this name.', () => pool.query('UPDATE cities SET ? WHERE id = ?', [data, req.params.id]));
  if (!r.affectedRows) fail(404, 'City not found.');
  res.json({ ok: true });
});

router.delete('/cities/:id', async (req, res) => {
  const [r] = await saving('', () => pool.query('DELETE FROM cities WHERE id = ?', [req.params.id]));
  if (!r.affectedRows) fail(404, 'City not found.');
  res.status(204).end();
});

// ================================================================ item categories
function readCategory(body) {
  return {
    name: text(body.name, 'The name', 2, 60),
    description: optionalText(body.description, 'The description', 200),
    is_active: body.isActive === undefined ? true : !!body.isActive,
  };
}

router.post('/categories', async (req, res) => {
  const [r] = await saving('A category with this name already exists.', () => pool.query('INSERT INTO item_categories SET ?', [readCategory(req.body)]));
  res.status(201).json({ id: r.insertId });
});

router.put('/categories/:id', async (req, res) => {
  const [r] = await saving('A category with this name already exists.', () => pool.query('UPDATE item_categories SET ? WHERE id = ?', [readCategory(req.body), req.params.id]));
  if (!r.affectedRows) fail(404, 'Category not found.');
  res.json({ ok: true });
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM item_categories WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) fail(404, 'Category not found.');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') fail(409, 'This category is used by item reports. Make it inactive instead.');
    throw err;
  }
  res.status(204).end();
});

// ================================================================ claim statuses (names only)
router.put('/claim-statuses/:id', async (req, res) => {
  const [r] = await saving('Another status already has this name.', () => pool.query('UPDATE claim_statuses SET name = ? WHERE id = ?', [text(req.body.name, 'The name', 3, 40), req.params.id]));
  if (!r.affectedRows) fail(404, 'Status not found.');
  res.json({ ok: true });
});

// ================================================================ activity log
router.get('/activity', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT a.id, a.action, a.details, a.created_at, a.item_id, a.claim_id, CONCAT(p.first_name, ' ', p.last_name) AS person
    FROM activity_log a LEFT JOIN persons p ON p.id = a.person_id
    ${req.query.action ? 'WHERE a.action = ?' : ''}
    ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, req.query.action ? [req.query.action] : []);
  res.json(rows);
});

module.exports = router;
