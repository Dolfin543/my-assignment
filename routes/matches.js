// Matches between lost and found items. Office admins review the system's suggestions for the
// found items at their office; owners see the confirmed matches of their lost items.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, oneOf, inTransaction } = require('../lib/validate');
const { isSystemAdmin, log } = require('../lib/rules');
const { suggestMatches } = require('../lib/matching');

const router = express.Router();
const staffOnly = requireRole('office_admin', 'system_admin');

const SELECT = `
  SELECT m.id, m.match_status, m.score, m.match_date, m.decided_at, m.lost_item_id, m.found_item_id,
         li.item_name AS lost_name, li.description AS lost_description, li.colour AS lost_colour, li.brand AS lost_brand,
         l.lost_ref, l.date_lost, lc.name AS lost_city, li.status AS lost_status,
         CONCAT(op.first_name, ' ', op.last_name) AS owner_name,
         fi.item_name AS found_name, fi.description AS found_description, fi.colour AS found_colour, fi.brand AS found_brand,
         f.found_ref, f.found_date, f.received_at, fc.name AS found_city, fi.status AS found_status, f.lfo_id, o.name AS office_name,
         cat.name AS category, CONCAT(dp.first_name, ' ', dp.last_name) AS decided_by_name
  FROM matches m
  JOIN lost_items l ON l.item_id = m.lost_item_id
  JOIN items li ON li.id = l.item_id
  JOIN cities lc ON lc.id = li.city_id
  JOIN found_items f ON f.item_id = m.found_item_id
  JOIN items fi ON fi.id = f.item_id
  JOIN cities fc ON fc.id = fi.city_id
  JOIN lost_found_offices o ON o.id = f.lfo_id
  JOIN item_categories cat ON cat.id = li.category_id
  LEFT JOIN persons op ON op.id = l.owner_id
  LEFT JOIN persons dp ON dp.id = m.decided_by`;

router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const where = [];
  const params = [];
  if (user.role === 'member') {
    where.push("l.owner_id = ? AND m.match_status = 'confirmed'");
    params.push(user.id);
  } else if (user.role === 'office_admin') {
    where.push('f.lfo_id = ?');
    params.push(user.officeId);
  }
  if (['suggested', 'confirmed', 'rejected'].includes(req.query.status)) { where.push('m.match_status = ?'); params.push(req.query.status); }
  if (req.query.active === '1') where.push("li.status IN ('open', 'matched') AND fi.status IN ('open', 'matched')");
  const [rows] = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m.match_status = 'suggested' DESC, m.score DESC, m.match_date DESC LIMIT 300`, params);
  // Members only learn where the item is; not who found it or what else it looks like.
  if (user.role === 'member') for (const r of rows) { r.found_description = null; }
  res.json(rows);
});

// Look for matches again for one item (e.g. after details were added).
router.post('/run/:itemId', staffOnly, async (req, res) => {
  const count = await inTransaction((conn) => suggestMatches(conn, req.params.itemId));
  res.json({ suggestions: count });
});

// Confirm or reject a suggestion. Confirming marks both items "matched"; the owner sees where
// their item is and can claim it.
router.put('/:id', staffOnly, async (req, res) => {
  const user = req.session.user;
  const decision = oneOf(req.body.decision, ['confirm', 'reject'], 'decision');
  try {
    await inTransaction(async (conn) => {
      const [[m]] = await conn.query(`SELECT m.*, f.lfo_id, li.status AS lost_status, fi.status AS found_status
        FROM matches m JOIN found_items f ON f.item_id = m.found_item_id JOIN items li ON li.id = m.lost_item_id JOIN items fi ON fi.id = m.found_item_id
        WHERE m.id = ? FOR UPDATE`, [req.params.id]);
      if (!m) fail(404, 'Match not found.');
      if (!isSystemAdmin(user) && m.lfo_id !== user.officeId) fail(403, 'This found item is kept by another office.');
      if (m.match_status !== 'suggested') fail(409, `This match was already ${m.match_status}.`);
      if (decision === 'confirm') {
        if (!['open', 'matched'].includes(m.lost_status) || !['open', 'matched'].includes(m.found_status)) fail(409, 'One of the items is no longer open.');
        await conn.query("UPDATE matches SET match_status = 'confirmed', decided_by = ?, decided_at = NOW() WHERE id = ?", [user.id, m.id]);
        await conn.query("UPDATE items SET status = 'matched' WHERE id IN (?, ?) AND status = 'open'", [m.lost_item_id, m.found_item_id]);
        // Other suggestions for these two items are no longer needed.
        await conn.query(`UPDATE matches SET match_status = 'rejected', decided_by = ?, decided_at = NOW()
          WHERE match_status = 'suggested' AND id <> ? AND (lost_item_id = ? OR found_item_id = ?)`, [user.id, m.id, m.lost_item_id, m.found_item_id]);
        await log(conn, { personId: user.id, itemId: m.found_item_id, action: 'match_confirmed', details: `lost item ${m.lost_item_id}` });
      } else {
        await conn.query("UPDATE matches SET match_status = 'rejected', decided_by = ?, decided_at = NOW() WHERE id = ?", [user.id, m.id]);
        await log(conn, { personId: user.id, itemId: m.found_item_id, action: 'match_rejected', details: `lost item ${m.lost_item_id}` });
      }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') fail(409, 'One of these items already has a confirmed match.');
    throw err;
  }
  res.json({ ok: true });
});

module.exports = router;
