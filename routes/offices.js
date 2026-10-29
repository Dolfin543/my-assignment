// Lost-and-found offices (shopping mall, police station, airport). Everyone logged in can see them
// (to know where to hand in or collect items); the system admin adds and changes them. Office
// admins manage the admins of their own office.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, optionalText, oneOf, phone: readPhone, inTransaction } = require('../lib/validate');
const { readAddress, saveAddress, removeAddress } = require('../lib/addresses');
const { readNamesAndEmail, readUsername, usernameFromEmail, makeTempPassword, EMAIL_PATTERN } = require('../lib/accounts');
const { isSystemAdmin, log } = require('../lib/rules');

const router = express.Router();
const sysAdmin = requireRole('system_admin');
const TYPES = ['mall', 'police', 'airport'];
const SUBTYPE = { mall: 'shopping_malls', police: 'police_stations', airport: 'airports' };

const SELECT = `
  SELECT o.id, o.name, o.email, o.phone, o.lfo_type, o.hours, o.is_active, o.address_id,
         ad.street_number, ad.street_name, ad.suburb, ad.city_id, ct.name AS city, ct.province_id, pv.name AS province,
         CONCAT_WS(', ', CONCAT(ad.street_number, ' ', ad.street_name), ad.suburb, ct.name) AS address,
         sm.mall_code, sm.desk_location, ps.station_code, ps.precinct, ap.airport_code, ap.iata_code, ap.terminal,
         COALESCE(sm.mall_code, ps.station_code, ap.airport_code) AS office_code,
         (SELECT COUNT(*) FROM found_items f JOIN items i ON i.id = f.item_id WHERE f.lfo_id = o.id AND i.status IN ('open', 'matched', 'claimed')) AS items_held,
         (SELECT COUNT(*) FROM it_admins ia WHERE ia.lfo_id = o.id) AS admin_count
  FROM lost_found_offices o
  JOIN addresses ad ON ad.id = o.address_id
  JOIN cities ct ON ct.id = ad.city_id
  JOIN provinces pv ON pv.id = ct.province_id
  LEFT JOIN shopping_malls sm ON sm.lfo_id = o.id
  LEFT JOIN police_stations ps ON ps.lfo_id = o.id
  LEFT JOIN airports ap ON ap.lfo_id = o.id`;

router.get('/', requireLogin, async (req, res) => {
  const where = [];
  const params = [];
  if (!isSystemAdmin(req.session.user) || req.query.active === '1') where.push('o.is_active');
  if (TYPES.includes(req.query.type)) { where.push('o.lfo_type = ?'); params.push(req.query.type); }
  if (req.query.provinceId) { where.push('ct.province_id = ?'); params.push(req.query.provinceId); }
  if (req.query.cityId) { where.push('ad.city_id = ?'); params.push(req.query.cityId); }
  if (req.query.q) { where.push('(o.name LIKE ? OR ct.name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const [rows] = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pv.name, ct.name, o.name`, params);
  res.json(rows);
});

const canManageOffice = (user, officeId) => isSystemAdmin(user) || (user.role === 'office_admin' && user.officeId === Number(officeId));

router.get('/:id', requireLogin, async (req, res) => {
  const [[office]] = await pool.query(`${SELECT} WHERE o.id = ?`, [req.params.id]);
  if (!office || (!office.is_active && !isSystemAdmin(req.session.user))) fail(404, 'Office not found.');
  if (canManageOffice(req.session.user, office.id)) {
    const [admins] = await pool.query(`
      SELECT ia.id, p.id AS person_id, p.first_name, p.last_name, p.username, p.email, p.phone, p.is_active, ia.created_at,
             CONCAT(ab.first_name, ' ', ab.last_name) AS added_by_name
      FROM it_admins ia JOIN persons p ON p.id = ia.person_id LEFT JOIN persons ab ON ab.id = ia.added_by
      WHERE ia.lfo_id = ? ORDER BY p.first_name, p.last_name`, [office.id]);
    office.admins = admins;
    office.canManage = true;
  }
  res.json(office);
});

async function readOffice(body) {
  const lfoType = oneOf(body.lfoType, TYPES, 'office type');
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) fail(400, 'Enter a valid email address for the office.');
  const phone = readPhone(body.phone);
  if (!phone) fail(400, 'Enter the office phone number.');
  const sub = {};
  if (lfoType === 'mall') sub.desk_location = text(body.deskLocation, 'The desk location', 3, 120);
  if (lfoType === 'police') sub.precinct = text(body.precinct, 'The precinct', 2, 80);
  if (lfoType === 'airport') {
    sub.iata_code = String(body.iataCode || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(sub.iata_code)) fail(400, 'The airport code must be 3 letters, e.g. UTT.');
    sub.terminal = optionalText(body.terminal, 'The terminal', 40);
  }
  return {
    office: {
      name: text(body.name, 'The office name', 3, 120), email, phone, lfo_type: lfoType,
      hours: optionalText(body.hours, 'The opening hours', 120), is_active: body.isActive === undefined ? true : !!body.isActive,
    },
    sub,
    address: await readAddress(body),
  };
}

function duplicate(err) {
  if (err.code !== 'ER_DUP_ENTRY') throw err;
  if (/iata/.test(err.message)) fail(409, 'Another airport already has this code.');
  fail(409, 'An office with this name already exists.');
}

// The office row and its subtype row are written together (disjoint subtypes).
router.post('/', sysAdmin, async (req, res) => {
  const { office, sub, address } = await readOffice(req.body);
  try {
    const id = await inTransaction(async (conn) => {
      const addressId = await saveAddress(conn, null, address);
      const [r] = await conn.query('INSERT INTO lost_found_offices SET ?', [{ ...office, address_id: addressId }]);
      await conn.query(`INSERT INTO ${SUBTYPE[office.lfo_type]} SET ?`, [{ ...sub, lfo_id: r.insertId }]);
      await log(conn, { personId: req.session.user.id, action: 'office_created', details: office.name });
      return r.insertId;
    });
    res.status(201).json({ id });
  } catch (err) { duplicate(err); }
});

// Changing the type replaces the subtype row. Office admins may change their own office's
// contact details and hours, but not its type or name.
router.put('/:id', requireRole('office_admin', 'system_admin'), async (req, res) => {
  const user = req.session.user;
  if (!canManageOffice(user, req.params.id)) fail(403, 'You can only change your own office.');
  const [[current]] = await pool.query('SELECT * FROM lost_found_offices WHERE id = ?', [req.params.id]);
  if (!current) fail(404, 'Office not found.');
  const { office, sub, address } = await readOffice(isSystemAdmin(user) ? req.body : { ...req.body, name: current.name, lfoType: current.lfo_type, isActive: current.is_active });
  try {
    await inTransaction(async (conn) => {
      await saveAddress(conn, current.address_id, address);
      if (office.lfo_type !== current.lfo_type) {
        await conn.query(`DELETE FROM ${SUBTYPE[current.lfo_type]} WHERE lfo_id = ?`, [current.id]);
        await conn.query('UPDATE lost_found_offices SET ? WHERE id = ?', [office, current.id]);
        await conn.query(`INSERT INTO ${SUBTYPE[office.lfo_type]} SET ?`, [{ ...sub, lfo_id: current.id }]);
      } else {
        await conn.query('UPDATE lost_found_offices SET ? WHERE id = ?', [office, current.id]);
        await conn.query(`UPDATE ${SUBTYPE[office.lfo_type]} SET ? WHERE lfo_id = ?`, [sub, current.id]);
      }
      await log(conn, { personId: user.id, action: 'office_updated', details: office.name });
    });
    res.json({ ok: true });
  } catch (err) { duplicate(err); }
});

// An office with items or reports is kept (deactivate it instead).
router.delete('/:id', sysAdmin, async (req, res) => {
  await inTransaction(async (conn) => {
    const [[o]] = await conn.query('SELECT * FROM lost_found_offices WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!o) fail(404, 'Office not found.');
    const [[{ n }]] = await conn.query('SELECT (SELECT COUNT(*) FROM found_items WHERE lfo_id = ?) + (SELECT COUNT(*) FROM lost_items WHERE lfo_id = ?) AS n', [o.id, o.id]);
    if (n) fail(409, 'This office has item reports and is kept for the records. Make it inactive instead.');
    await conn.query("UPDATE persons p JOIN it_admins ia ON ia.person_id = p.id SET p.role = 'member' WHERE ia.lfo_id = ?", [o.id]);
    await conn.query('DELETE FROM it_admins WHERE lfo_id = ?', [o.id]);
    await conn.query(`DELETE FROM ${SUBTYPE[o.lfo_type]} WHERE lfo_id = ?`, [o.id]);
    await conn.query('DELETE FROM lost_found_offices WHERE id = ?', [o.id]);
    await removeAddress(conn, o.address_id);
    await log(conn, { personId: req.session.user.id, action: 'office_deleted', details: o.name });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- the office's admins
// Add an admin: an existing member (by username or email) or a new account with a temporary password.
router.post('/:id/admins', requireRole('office_admin', 'system_admin'), async (req, res) => {
  const user = req.session.user;
  if (!canManageOffice(user, req.params.id)) fail(403, 'You can only manage the admins of your own office.');
  const [[office]] = await pool.query('SELECT id, name FROM lost_found_offices WHERE id = ?', [req.params.id]);
  if (!office) fail(404, 'Office not found.');
  const result = await inTransaction(async (conn) => {
    let person;
    let tempPassword = null;
    if (req.body.login) {
      const login = String(req.body.login).trim().toLowerCase();
      [[person]] = await conn.query('SELECT p.*, ia.lfo_id FROM persons p LEFT JOIN it_admins ia ON ia.person_id = p.id WHERE p.username = ? OR p.email = ? FOR UPDATE', [login, login]);
      if (!person) fail(404, 'No account with that username or email.');
      if (person.role === 'system_admin') fail(409, 'A system administrator cannot be an office admin.');
      if (person.lfo_id) fail(409, person.lfo_id === office.id ? 'This person is already an admin of this office.' : 'This person is already an admin of another office.');
    } else {
      const details = readNamesAndEmail(req.body);
      if (details.error) fail(400, details.error);
      const username = readUsername(req.body.username || usernameFromEmail(details.email));
      if (!username) fail(400, 'The username must be 3–30 letters, digits, dots, dashes or underscores.');
      tempPassword = makeTempPassword();
      try {
        const [r] = await conn.query(`INSERT INTO persons (first_name, last_name, username, email, phone, password_hash, must_change_password, role)
          VALUES (?, ?, ?, ?, ?, ?, TRUE, 'office_admin')`,
        [details.firstName, details.lastName, username, details.email, readPhone(req.body.phone), await bcrypt.hash(tempPassword, 10)]);
        person = { id: r.insertId, username, first_name: details.firstName, last_name: details.lastName };
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') fail(409, 'That username or email is already used. Add the existing account instead.');
        throw err;
      }
    }
    await conn.query("UPDATE persons SET role = 'office_admin' WHERE id = ?", [person.id]);
    await conn.query('INSERT INTO it_admins (lfo_id, person_id, added_by) VALUES (?, ?, ?)', [office.id, person.id, user.id]);
    await log(conn, { personId: user.id, action: 'office_admin_added', details: `${person.username} → ${office.name}` });
    return { personId: person.id, username: person.username, name: `${person.first_name} ${person.last_name}`, tempPassword };
  });
  res.status(201).json(result);
});

// Remove an admin from the office; they become an ordinary member.
router.delete('/:id/admins/:personId', requireRole('office_admin', 'system_admin'), async (req, res) => {
  const user = req.session.user;
  if (!canManageOffice(user, req.params.id)) fail(403, 'You can only manage the admins of your own office.');
  if (Number(req.params.personId) === user.id) fail(400, 'You cannot remove yourself. Ask another admin of your office.');
  await inTransaction(async (conn) => {
    const [r] = await conn.query('DELETE FROM it_admins WHERE lfo_id = ? AND person_id = ?', [req.params.id, req.params.personId]);
    if (!r.affectedRows) fail(404, 'This person is not an admin of this office.');
    await conn.query("UPDATE persons SET role = 'member' WHERE id = ?", [req.params.personId]);
    await log(conn, { personId: user.id, action: 'office_admin_removed', details: `person ${req.params.personId} from office ${req.params.id}` });
  });
  res.status(204).end();
});

module.exports = router;
