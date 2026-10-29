// Lost and found items: report, browse/search, view, edit, receive at the office, close, delete, photos.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const { fail, text, optionalText, exists, date, inTransaction } = require('../lib/validate');
const {
  isSystemAdmin, visibleItemsSql, canManage, isOwnReport, ensureOwner, ensureReporter, log, readPhotos, savePhotos,
} = require('../lib/rules');
const { suggestMatches } = require('../lib/matching');

const router = express.Router();

const ITEM_SELECT = `
  SELECT i.id, i.item_type, i.item_name, i.category_id, cat.name AS category, i.description, i.colour, i.brand,
         i.city_id, ic.name AS city, ic.province_id, pv.name AS province, i.place_detail, i.status, i.date_reported, i.updated_at,
         l.lost_ref, l.date_lost, l.owner_id, f.found_ref, f.found_date, f.received_at, f.storage_location,
         COALESCE(l.reporter_id, f.reporter_id) AS reporter_id,
         COALESCE(f.lfo_id, l.lfo_id) AS lfo_id, o.name AS office_name, o.lfo_type AS office_type,
         COALESCE(l.lost_ref, f.found_ref) AS ref,
         COALESCE(l.date_lost, f.found_date) AS event_date,
         (SELECT p.id FROM item_photos p WHERE p.item_id = i.id AND p.is_public ORDER BY p.id LIMIT 1) AS photo_id
  FROM items i
  JOIN item_categories cat ON cat.id = i.category_id
  JOIN cities ic ON ic.id = i.city_id
  JOIN provinces pv ON pv.id = ic.province_id
  LEFT JOIN lost_items l ON l.item_id = i.id
  LEFT JOIN found_items f ON f.item_id = i.id
  LEFT JOIN lost_found_offices o ON o.id = COALESCE(f.lfo_id, l.lfo_id)`;

// Loads an item the user may see, or fails with 404.
async function visibleItem(user, id, conn = pool) {
  const vis = await visibleItemsSql(user);
  const [[item]] = await conn.query(`${ITEM_SELECT} WHERE i.id = ? AND ${vis.sql}`, [id, ...vis.params]);
  if (!item) fail(404, 'Item not found.');
  return item;
}

// ---------------------------------------------------------------- browse and search
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const vis = await visibleItemsSql(user);
  const where = [vis.sql];
  const params = [...vis.params];
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    where.push('(i.item_name LIKE ? OR i.description LIKE ? OR i.brand LIKE ? OR i.colour LIKE ? OR i.place_detail LIKE ? OR l.lost_ref = ? OR f.found_ref = ?)');
    params.push(like, like, like, like, like, q.toUpperCase(), q.toUpperCase());
  }
  if (['lost', 'found'].includes(req.query.type)) { where.push('i.item_type = ?'); params.push(req.query.type); }
  if (['open', 'matched', 'claimed', 'returned', 'closed'].includes(req.query.status)) { where.push('i.status = ?'); params.push(req.query.status); }
  if (req.query.active === '1') where.push("i.status IN ('open', 'matched')");
  const filters = { categoryId: 'i.category_id', cityId: 'i.city_id', provinceId: 'ic.province_id', officeId: 'COALESCE(f.lfo_id, l.lfo_id)' };
  for (const [key, col] of Object.entries(filters)) {
    if (req.query[key]) { where.push(`${col} = ?`); params.push(req.query[key]); }
  }
  if (req.query.from) { where.push('COALESCE(l.date_lost, f.found_date) >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('COALESCE(l.date_lost, f.found_date) <= ?'); params.push(req.query.to); }
  if (req.query.mine === '1') { where.push('(l.reporter_id = ? OR l.owner_id = ? OR f.reporter_id = ?)'); params.push(user.id, user.id, user.id); }
  if (req.query.notReceived === '1') where.push("i.item_type = 'found' AND f.received_at IS NULL AND i.status <> 'closed'");
  const [rows] = await pool.query(`${ITEM_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY i.date_reported DESC, i.id DESC LIMIT 300`, params);
  res.json(rows.map((r) => ({ ...r, isOwn: isOwnReport(user, r) })));
});

// ---------------------------------------------------------------- one item
router.get('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const manage = await canManage(user, item);
  const own = isOwnReport(user, item);
  const result = { ...item, canManage: manage, isOwn: own };

  const [photos] = await pool.query('SELECT id, file_name, is_public FROM item_photos WHERE item_id = ? ORDER BY id', [item.id]);
  result.photos = photos.filter((p) => p.is_public || manage || own);

  // Office details (where to hand in / collect).
  if (item.lfo_id) {
    const [[office]] = await pool.query(`
      SELECT o.id, o.name, o.lfo_type, o.phone, o.email, o.hours,
             CONCAT_WS(', ', CONCAT(ad.street_number, ' ', ad.street_name), ad.suburb, ct.name) AS address
      FROM lost_found_offices o JOIN addresses ad ON ad.id = o.address_id JOIN cities ct ON ct.id = ad.city_id WHERE o.id = ?`, [item.lfo_id]);
    result.office = office;
  }

  if (manage || own) {
    const [[people]] = await pool.query(`
      SELECT CONCAT(rp.first_name, ' ', rp.last_name) AS reporter_name, rp.email AS reporter_email, rp.phone AS reporter_phone,
             CONCAT(op.first_name, ' ', op.last_name) AS owner_name, op.email AS owner_email, op.phone AS owner_phone,
             fi.hidden_details, CONCAT(rb.first_name, ' ', rb.last_name) AS received_by_name
      FROM items i
      LEFT JOIN lost_items l ON l.item_id = i.id
      LEFT JOIN found_items fi ON fi.item_id = i.id
      LEFT JOIN persons rp ON rp.id = COALESCE(l.reporter_id, fi.reporter_id)
      LEFT JOIN persons op ON op.id = l.owner_id
      LEFT JOIN persons rb ON rb.id = fi.received_by
      WHERE i.id = ?`, [item.id]);
    Object.assign(result, people);
    // A finder who reported a found item sees what they wrote, but not after the office takes over.
    if (!manage && item.item_type === 'found') result.hidden_details = item.received_at ? null : people.hidden_details;
  }

  // Matches: staff see every suggestion; the owner of a lost item sees confirmed matches.
  const col = item.item_type === 'lost' ? 'm.lost_item_id' : 'm.found_item_id';
  const otherCol = item.item_type === 'lost' ? 'm.found_item_id' : 'm.lost_item_id';
  if (manage || (own && item.item_type === 'lost')) {
    const [matches] = await pool.query(`
      SELECT m.id, m.match_status, m.score, m.match_date, m.decided_at, ${otherCol} AS other_id,
             oi.item_name AS other_name, oi.status AS other_status, COALESCE(ol.lost_ref, ofo.found_ref) AS other_ref,
             COALESCE(ol.date_lost, ofo.found_date) AS other_date, oc.name AS other_city, oo.name AS other_office,
             CONCAT(dp.first_name, ' ', dp.last_name) AS decided_by_name
      FROM matches m
      JOIN items oi ON oi.id = ${otherCol}
      JOIN cities oc ON oc.id = oi.city_id
      LEFT JOIN lost_items ol ON ol.item_id = oi.id
      LEFT JOIN found_items ofo ON ofo.item_id = oi.id
      LEFT JOIN lost_found_offices oo ON oo.id = ofo.lfo_id
      LEFT JOIN persons dp ON dp.id = m.decided_by
      WHERE ${col} = ? ${manage ? '' : "AND m.match_status = 'confirmed'"}
      ORDER BY m.match_status = 'confirmed' DESC, m.score DESC`, [item.id]);
    result.matches = matches;
  }
  // A member looking at a found item that was matched to their own lost report: the claim links to it.
  if (!manage && item.item_type === 'found') {
    const [[mine]] = await pool.query(`SELECT m.lost_item_id FROM matches m JOIN lost_items l ON l.item_id = m.lost_item_id
      WHERE m.found_item_id = ? AND m.match_status = 'confirmed' AND l.owner_id = ?`, [item.id, user.id]);
    result.myMatchedLostId = mine ? mine.lost_item_id : null;
  }

  // Claims on a found item: staff see all of them (with the claimant's record of rejected claims).
  if (item.item_type === 'found') {
    const [claims] = await pool.query(`
      SELECT c.id, c.claim_date, c.proof_description, c.decision_notes, c.reviewed_at, c.restitution_date, c.id_verified, c.owner_id,
             cs.code AS status_code, cs.name AS status, CONCAT(p.first_name, ' ', p.last_name) AS claimant, p.email AS claimant_email, p.phone AS claimant_phone,
             (SELECT COUNT(*) FROM claims c2 JOIN claim_statuses s2 ON s2.id = c2.claim_status_id WHERE c2.owner_id = c.owner_id AND s2.code = 'rejected') AS rejected_claims
      FROM claims c JOIN claim_statuses cs ON cs.id = c.claim_status_id LEFT JOIN persons p ON p.id = c.owner_id
      WHERE c.found_item_id = ? ${manage ? '' : 'AND c.owner_id = ?'}
      ORDER BY c.claim_date DESC`, manage ? [item.id] : [item.id, user.id]);
    result.claims = claims;
    const active = claims.some((c) => c.owner_id === user.id && ['pending', 'under_review', 'approved'].includes(c.status_code));
    result.canClaim = !manage && !own && ['open', 'matched'].includes(item.status) && !active;
  }

  if (manage) {
    const [activity] = await pool.query(`
      SELECT a.action, a.details, a.created_at, CONCAT(p.first_name, ' ', p.last_name) AS person
      FROM activity_log a LEFT JOIN persons p ON p.id = a.person_id
      WHERE a.item_id = ? OR a.claim_id IN (SELECT id FROM claims WHERE found_item_id = ?)
      ORDER BY a.created_at DESC, a.id DESC LIMIT 50`, [item.id, item.id]);
    result.activity = activity;
  }
  res.json(result);
});

router.get('/:id/photos/:photoId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const [[photo]] = await pool.query('SELECT mime_type, data, is_public FROM item_photos WHERE id = ? AND item_id = ?', [req.params.photoId, item.id]);
  if (!photo || (!photo.is_public && !isOwnReport(user, item) && !await canManage(user, item))) fail(404, 'Photo not found.');
  res.set('Content-Type', photo.mime_type).set('Cache-Control', 'private, max-age=3600').send(photo.data);
});

// ---------------------------------------------------------------- report
const today = () => new Date().toISOString().slice(0, 10);

async function readCommon(body) {
  return {
    item_name: text(body.itemName, 'The item name', 2, 100),
    category_id: await exists('item_categories', body.categoryId, 'category', { activeOnly: true }),
    description: text(body.description, 'The description', 5, 3000),
    colour: optionalText(body.colour, 'The colour', 40),
    brand: optionalText(body.brand, 'The brand', 60),
    city_id: await exists('cities', body.cityId, 'city'),
    place_detail: optionalText(body.placeDetail, 'The place', 200),
  };
}

function readEventDate(value, label) {
  const d = date(value, label);
  if (d > today()) fail(400, `The ${label} cannot be in the future.`);
  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
  if (d < twoYearsAgo) fail(400, `The ${label} cannot be more than two years ago.`);
  return d;
}

async function activeOffice(id, label, optional = false) {
  const officeId = await exists('lost_found_offices', id, label, { optional, activeOnly: true });
  return officeId;
}

// A member reports something they lost. They are both its reporter and its owner.
router.post('/lost', requireLogin, async (req, res) => {
  const user = req.session.user;
  const common = await readCommon(req.body);
  const dateLost = readEventDate(req.body.dateLost, 'date it was lost');
  const officeId = await activeOffice(req.body.officeId, 'office', true);
  const photos = readPhotos(req.body.photos);
  const { id, suggestions } = await inTransaction(async (conn) => {
    const [r] = await conn.query("INSERT INTO items SET ?, item_type = 'lost'", [common]);
    await ensureOwner(conn, user.id);
    await ensureReporter(conn, user.id);
    await conn.query('INSERT INTO lost_items (item_id, reporter_id, owner_id, lfo_id, date_lost) VALUES (?, ?, ?, ?, ?)',
      [r.insertId, user.id, user.id, officeId, dateLost]);
    await savePhotos(conn, r.insertId, photos);
    await log(conn, { personId: user.id, itemId: r.insertId, action: 'lost_reported', details: common.item_name });
    return { id: r.insertId, suggestions: await suggestMatches(conn, r.insertId) };
  });
  res.status(201).json({ id, suggestions });
});

// Somebody reports something they found and the office it is (or will be) handed in at.
// When an admin of that office logs it, it is received at once.
router.post('/found', requireLogin, async (req, res) => {
  const user = req.session.user;
  const common = await readCommon(req.body);
  const foundDate = readEventDate(req.body.foundDate, 'date it was found');
  const officeId = await activeOffice(req.body.officeId, 'lost-and-found office');
  const atOffice = isSystemAdmin(user) || (user.role === 'office_admin' && user.officeId === officeId);
  const hidden = optionalText(req.body.hiddenDetails, 'The hidden details', 1000);
  const storage = atOffice ? optionalText(req.body.storageLocation, 'The storage location', 100) : null;
  const photos = readPhotos(req.body.photos);
  const { id, suggestions } = await inTransaction(async (conn) => {
    const [r] = await conn.query("INSERT INTO items SET ?, item_type = 'found'", [common]);
    await ensureReporter(conn, user.id);
    await conn.query(`INSERT INTO found_items (item_id, reporter_id, lfo_id, found_date, received_at, received_by, storage_location, hidden_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [r.insertId, user.id, officeId, foundDate, atOffice ? new Date() : null, atOffice ? user.id : null, storage, hidden]);
    await savePhotos(conn, r.insertId, photos);
    await log(conn, { personId: user.id, itemId: r.insertId, action: atOffice ? 'found_logged' : 'found_reported', details: common.item_name });
    return { id: r.insertId, suggestions: await suggestMatches(conn, r.insertId) };
  });
  res.status(201).json({ id, suggestions });
});

// ---------------------------------------------------------------- change
// The reporter/owner edits while the report is open; office admins edit the items they manage
// (for example to complete an incomplete report).
router.put('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const manage = await canManage(user, item);
  if (!manage) {
    if (!isOwnReport(user, item)) fail(403, 'You can only change your own reports.');
    if (item.status !== 'open') fail(409, 'This report is already being handled. Contact the office to change it.');
  }
  if (['returned', 'closed'].includes(item.status)) fail(409, 'A returned or closed item cannot be changed.');
  const common = await readCommon(req.body);
  await inTransaction(async (conn) => {
    await conn.query('UPDATE items SET ? WHERE id = ?', [common, item.id]);
    if (item.item_type === 'lost') {
      const officeId = await activeOffice(req.body.officeId, 'office', true);
      await conn.query('UPDATE lost_items SET date_lost = ?, lfo_id = ? WHERE item_id = ?', [readEventDate(req.body.dateLost, 'date it was lost'), officeId, item.id]);
    } else {
      const set = { found_date: readEventDate(req.body.foundDate, 'date it was found') };
      if (item.received_at && set.found_date > new Date(item.received_at).toISOString().slice(0, 10)) fail(400, 'The item cannot have been found after the office received it.');
      if (manage || !item.received_at) set.hidden_details = optionalText(req.body.hiddenDetails, 'The hidden details', 1000);
      if (manage) {
        set.storage_location = optionalText(req.body.storageLocation, 'The storage location', 100);
        if (isSystemAdmin(user) && req.body.officeId) set.lfo_id = await activeOffice(req.body.officeId, 'lost-and-found office');
      }
      await conn.query('UPDATE found_items SET ? WHERE item_id = ?', [set, item.id]);
    }
    await log(conn, { personId: user.id, itemId: item.id, action: 'item_edited' });
    await suggestMatches(conn, item.id);
  });
  res.json({ ok: true });
});

// The office has the found item in its hands.
router.post('/:id/receive', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  if (item.item_type !== 'found' || !await canManage(user, item)) fail(403, 'Only the office keeping this item can receive it.');
  if (item.received_at) fail(409, 'This item has already been received.');
  if (item.status === 'closed') fail(409, 'This report is closed.');
  const storage = optionalText(req.body.storageLocation, 'The storage location', 100);
  await inTransaction(async (conn) => {
    await conn.query('UPDATE found_items SET received_at = NOW(), received_by = ?, storage_location = ? WHERE item_id = ?', [user.id, storage, item.id]);
    await log(conn, { personId: user.id, itemId: item.id, action: 'found_received', details: storage });
  });
  res.json({ ok: true });
});

// Close a report: the owner found it themselves, the finder made a mistake, or an office admin
// closes an incomplete or fraudulent report or disposes of an unclaimed item. Open claims on it
// are rejected with the reason.
router.post('/:id/close', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const manage = await canManage(user, item);
  if (!manage && !isOwnReport(user, item)) fail(403, 'You can only close your own reports.');
  if (!manage && item.status !== 'open') fail(409, 'This report is already being handled. Contact the office.');
  if (['returned', 'closed'].includes(item.status)) fail(409, 'This item is already returned or closed.');
  const reason = text(req.body.reason, 'The reason', 5, 300);
  await inTransaction(async (conn) => {
    if (item.item_type === 'found') {
      const [[approved]] = await conn.query('SELECT id FROM claims WHERE found_item_id = ? AND approved_flag = 1', [item.id]);
      if (approved) fail(409, 'A claim on this item was approved. Record the return or reject the claim first.');
      const [[rejected]] = await conn.query("SELECT id FROM claim_statuses WHERE code = 'rejected'");
      await conn.query(`UPDATE claims c JOIN claim_statuses s ON s.id = c.claim_status_id
        SET c.claim_status_id = ?, c.decision_notes = ?, c.reviewed_by = ?, c.reviewed_at = GREATEST(NOW(), c.claim_date)
        WHERE c.found_item_id = ? AND s.code IN ('pending', 'under_review')`, [rejected.id, `Item closed: ${reason}`, user.id, item.id]);
    }
    await conn.query("UPDATE items SET status = 'closed' WHERE id = ?", [item.id]);
    await conn.query("UPDATE matches SET match_status = 'rejected', decided_by = ?, decided_at = NOW() WHERE match_status = 'suggested' AND (lost_item_id = ? OR found_item_id = ?)",
      [user.id, item.id, item.id]);
    await log(conn, { personId: user.id, itemId: item.id, action: 'item_closed', details: reason });
  });
  res.json({ ok: true });
});

// Office admins reopen a report closed by mistake.
router.post('/:id/reopen', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  if (!await canManage(user, item)) fail(403, 'Only an office admin can reopen a report.');
  if (item.status !== 'closed') fail(409, 'Only a closed report can be reopened.');
  await inTransaction(async (conn) => {
    await conn.query("UPDATE items SET status = 'open' WHERE id = ?", [item.id]);
    await log(conn, { personId: user.id, itemId: item.id, action: 'item_reopened' });
    await suggestMatches(conn, item.id);
  });
  res.json({ ok: true });
});

// Delete a report entered by mistake. Reports with claims or a confirmed match are kept for the
// records (close them instead).
router.delete('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const manage = await canManage(user, item);
  if (!manage && !isOwnReport(user, item)) fail(403, 'You can only delete your own reports.');
  if (!manage && item.status !== 'open') fail(409, 'This report is already being handled and cannot be deleted.');
  await inTransaction(async (conn) => {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM claims WHERE found_item_id = ? OR lost_item_id = ?', [item.id, item.id]);
    if (n) fail(409, 'This report has claims and is kept for the records. Close it instead.');
    const [[{ m }]] = await conn.query("SELECT COUNT(*) AS m FROM matches WHERE match_status = 'confirmed' AND (lost_item_id = ? OR found_item_id = ?)", [item.id, item.id]);
    if (m) fail(409, 'This report has a confirmed match and is kept for the records. Close it instead.');
    await log(conn, { personId: user.id, action: 'item_deleted', details: `${item.ref} ${item.item_name}` });
    await conn.query(`DELETE FROM ${item.item_type === 'lost' ? 'lost_items' : 'found_items'} WHERE item_id = ?`, [item.id]);
    await conn.query('DELETE FROM items WHERE id = ?', [item.id]);
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- photos
router.post('/:id/photos', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  if (!isOwnReport(user, item) && !await canManage(user, item)) fail(403, 'You can only add photos to your own reports.');
  if (['returned', 'closed'].includes(item.status)) fail(409, 'This item is returned or closed.');
  await inTransaction(async (conn) => {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM item_photos WHERE item_id = ? FOR UPDATE', [item.id]);
    const photos = readPhotos(req.body.photos, n);
    if (!photos.length) fail(400, 'Choose a photo to upload.');
    await savePhotos(conn, item.id, photos);
  });
  res.status(201).json({ ok: true });
});

router.put('/:id/photos/:photoId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  if (!isOwnReport(user, item) && !await canManage(user, item)) fail(403, 'You can only change photos of your own reports.');
  const [r] = await pool.query('UPDATE item_photos SET is_public = ? WHERE id = ? AND item_id = ?', [!!req.body.isPublic, req.params.photoId, item.id]);
  if (!r.affectedRows) fail(404, 'Photo not found.');
  res.json({ ok: true });
});

router.delete('/:id/photos/:photoId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const item = await visibleItem(user, req.params.id);
  const manage = await canManage(user, item);
  if (!manage && !isOwnReport(user, item)) fail(403, 'You can only remove photos from your own reports.');
  if (!manage && item.status !== 'open') fail(409, 'This report is being handled; its photos are kept.');
  const [r] = await pool.query('DELETE FROM item_photos WHERE id = ? AND item_id = ?', [req.params.photoId, item.id]);
  if (!r.affectedRows) fail(404, 'Photo not found.');
  res.status(204).end();
});

module.exports = router;
