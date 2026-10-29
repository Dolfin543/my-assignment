// Location-specific reports for office admins (their office and province) and the system admin
// (any province, city or office): reports, recoveries, claims and possible fraud.
const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');
const { fail, date, exists } = require('../lib/validate');
const { officeProvince } = require('../lib/rules');

const router = express.Router();

router.get('/summary', requireRole('office_admin', 'system_admin'), async (req, res) => {
  const user = req.session.user;
  const from = date(req.query.from, 'start date');
  const to = date(req.query.to, 'end date');
  if (to < from) fail(400, 'The end date cannot be before the start date.');
  let provinceId = await exists('provinces', req.query.provinceId, 'province', { optional: true });
  const cityId = await exists('cities', req.query.cityId, 'city', { optional: true });
  let officeId = await exists('lost_found_offices', req.query.officeId, 'office', { optional: true });
  if (user.role === 'office_admin') { // an office admin reports on their own office and province
    officeId = user.officeId;
    provinceId = await officeProvince(user.officeId);
  }

  // Items reported in the period, in the selected area.
  const where = ['i.date_reported BETWEEN ? AND ?'];
  const params = [`${from} 00:00:00`, `${to} 23:59:59`];
  if (provinceId) { where.push('ct.province_id = ?'); params.push(provinceId); }
  if (cityId) { where.push('i.city_id = ?'); params.push(cityId); }
  if (officeId) { where.push("(i.item_type = 'lost' OR f.lfo_id = ?)"); params.push(officeId); }
  const base = `FROM items i JOIN cities ct ON ct.id = i.city_id JOIN item_categories cat ON cat.id = i.category_id
    LEFT JOIN found_items f ON f.item_id = i.id LEFT JOIN lost_found_offices o ON o.id = f.lfo_id WHERE ${where.join(' AND ')}`;
  const q = async (sql, extra = []) => (await pool.query(sql, [...params, ...extra]))[0];

  const [totals] = await q(`
    SELECT COALESCE(SUM(i.item_type = 'lost'), 0) AS lost, COALESCE(SUM(i.item_type = 'found'), 0) AS found,
           COALESCE(SUM(i.item_type = 'found' AND i.status = 'returned'), 0) AS returned,
           COALESCE(SUM(i.status IN ('open', 'matched')), 0) AS still_open,
           COALESCE(SUM(i.item_type = 'lost' AND i.status = 'returned'), 0) AS lost_recovered,
           COALESCE(SUM(i.status = 'closed'), 0) AS closed
    ${base}`);
  totals.recovery_rate = totals.lost ? Math.round((100 * totals.lost_recovered) / totals.lost) : null;
  const byCategory = await q(`SELECT cat.name, COALESCE(SUM(i.item_type = 'lost'), 0) AS lost, COALESCE(SUM(i.item_type = 'found'), 0) AS found,
    COALESCE(SUM(i.status = 'returned'), 0) AS returned ${base} GROUP BY cat.id ORDER BY lost + found DESC, cat.name`);
  const byCity = await q(`SELECT ct.name, COALESCE(SUM(i.item_type = 'lost'), 0) AS lost, COALESCE(SUM(i.item_type = 'found'), 0) AS found
    ${base} GROUP BY ct.id ORDER BY lost + found DESC, ct.name LIMIT 12`);
  const byOffice = await q(`SELECT o.name, o.lfo_type, COUNT(*) AS found, COALESCE(SUM(i.status = 'returned'), 0) AS returned,
    COALESCE(SUM(i.status IN ('open', 'matched', 'claimed')), 0) AS held
    ${base} AND i.item_type = 'found' GROUP BY o.id ORDER BY found DESC, o.name`);
  const byMonth = await q(`SELECT DATE_FORMAT(i.date_reported, '%Y-%m') AS month, COALESCE(SUM(i.item_type = 'lost'), 0) AS lost,
    COALESCE(SUM(i.item_type = 'found'), 0) AS found ${base} GROUP BY month ORDER BY month`);

  // Claims made in the period on found items of the area.
  const cWhere = ['c.claim_date BETWEEN ? AND ?'];
  const cParams = [`${from} 00:00:00`, `${to} 23:59:59`];
  if (provinceId) { cWhere.push('ct.province_id = ?'); cParams.push(provinceId); }
  if (cityId) { cWhere.push('i.city_id = ?'); cParams.push(cityId); }
  if (officeId) { cWhere.push('f.lfo_id = ?'); cParams.push(officeId); }
  const cBase = `FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id JOIN found_items f ON f.item_id = c.found_item_id
    JOIN items i ON i.id = f.item_id JOIN cities ct ON ct.id = i.city_id WHERE ${cWhere.join(' AND ')}`;
  const [[claims]] = await pool.query(`
    SELECT COUNT(*) AS submitted, COALESCE(SUM(s.code IN ('pending', 'under_review')), 0) AS waiting,
           COALESCE(SUM(s.code IN ('approved', 'returned')), 0) AS approved, COALESCE(SUM(s.code = 'rejected'), 0) AS rejected,
           COALESCE(SUM(s.code = 'returned'), 0) AS returned,
           ROUND(AVG(CASE WHEN c.restitution_date IS NOT NULL THEN TIMESTAMPDIFF(HOUR, f.found_date, c.restitution_date) / 24 END), 1) AS avg_days_to_return,
           ROUND(AVG(CASE WHEN c.reviewed_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, c.claim_date, c.reviewed_at) / 60 END), 1) AS avg_hours_to_decide
    ${cBase}`, cParams);
  // People with two or more rejected claims in the area (possible fraud).
  const [flagged] = await pool.query(`
    SELECT p.id, CONCAT(p.first_name, ' ', p.last_name) AS name, p.username, COUNT(*) AS rejected
    ${cBase.replace('WHERE', 'JOIN persons p ON p.id = c.owner_id WHERE')} AND s.code = 'rejected'
    GROUP BY p.id HAVING rejected >= 2 ORDER BY rejected DESC`, cParams);

  res.json({ filters: { from, to, provinceId, cityId, officeId }, totals, byCategory, byCity, byOffice, byMonth, claims, flagged });
});

module.exports = router;
