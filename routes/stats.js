// Dashboard figures for the logged-in person's role.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const { officeProvince } = require('../lib/rules');

const router = express.Router();

router.get('/dashboard', requireLogin, async (req, res) => {
  const user = req.session.user;
  const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];
  const result = {};

  // Everyone: their own reports and claims.
  Object.assign(result, await one(`
    SELECT COALESCE(SUM(i.item_type = 'lost' AND i.status IN ('open', 'matched', 'claimed')), 0) AS my_lost_open,
           COALESCE(SUM(i.item_type = 'found'), 0) AS my_found,
           COALESCE(SUM(i.status = 'returned'), 0) AS my_returned
    FROM items i LEFT JOIN lost_items l ON l.item_id = i.id LEFT JOIN found_items f ON f.item_id = i.id
    WHERE l.owner_id = ? OR l.reporter_id = ? OR f.reporter_id = ?`, [user.id, user.id, user.id]));
  Object.assign(result, await one(`
    SELECT COALESCE(SUM(s.code IN ('pending', 'under_review')), 0) AS my_claims_waiting, COALESCE(SUM(s.code = 'approved'), 0) AS my_claims_approved
    FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id WHERE c.owner_id = ?`, [user.id]));
  Object.assign(result, await one(`
    SELECT COUNT(*) AS my_matches FROM matches m JOIN lost_items l ON l.item_id = m.lost_item_id JOIN items i ON i.id = l.item_id
    WHERE l.owner_id = ? AND m.match_status = 'confirmed' AND i.status = 'matched'`, [user.id]));
  Object.assign(result, await one("SELECT COUNT(*) AS found_on_board FROM items WHERE item_type = 'found' AND status IN ('open', 'matched')"));

  if (user.role !== 'member') {
    const office = user.role === 'office_admin' ? 'AND f.lfo_id = ?' : '';
    const p = user.role === 'office_admin' ? [user.officeId] : [];
    Object.assign(result, await one(`
      SELECT COALESCE(SUM(i.status IN ('open', 'matched', 'claimed') AND f.received_at IS NOT NULL), 0) AS items_held,
             COALESCE(SUM(f.received_at IS NULL AND i.status <> 'closed'), 0) AS to_receive,
             COALESCE(SUM(i.status = 'claimed'), 0) AS awaiting_collection
      FROM found_items f JOIN items i ON i.id = f.item_id WHERE TRUE ${office}`, p));
    Object.assign(result, await one(`
      SELECT COALESCE(SUM(s.code IN ('pending', 'under_review')), 0) AS claims_to_decide
      FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id JOIN found_items f ON f.item_id = c.found_item_id WHERE TRUE ${office}`, p));
    Object.assign(result, await one(`
      SELECT COUNT(*) AS suggested_matches FROM matches m JOIN found_items f ON f.item_id = m.found_item_id
      JOIN items li ON li.id = m.lost_item_id JOIN items fi ON fi.id = m.found_item_id
      WHERE m.match_status = 'suggested' AND li.status IN ('open', 'matched') AND fi.status IN ('open', 'matched') ${office}`, p));
    const area = user.role === 'office_admin' ? 'AND c.province_id = ?' : '';
    const ap = user.role === 'office_admin' ? [await officeProvince(user.officeId)] : [];
    Object.assign(result, await one(`
      SELECT COUNT(*) AS lost_in_area FROM items i JOIN cities c ON c.id = i.city_id
      WHERE i.item_type = 'lost' AND i.status IN ('open', 'matched') ${area}`, ap));
  }
  if (user.role === 'system_admin') {
    Object.assign(result, await one('SELECT COUNT(*) AS offices FROM lost_found_offices WHERE is_active'));
    Object.assign(result, await one('SELECT COUNT(*) AS people, COALESCE(SUM(NOT is_active), 0) AS inactive_people FROM persons'));
  }
  res.json(result);
});

module.exports = router;
