// Reference lists used by the forms. Provinces and cities are also needed by the registration
// form, so no login is required for them.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/provinces', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT p.id, p.name, COUNT(c.id) AS city_count FROM provinces p LEFT JOIN cities c ON c.province_id = p.id
    GROUP BY p.id ORDER BY p.name`);
  res.json(rows);
});

router.get('/cities', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.provinceId) { where = 'WHERE c.province_id = ?'; params.push(req.query.provinceId); }
  const [rows] = await pool.query(`
    SELECT c.id, c.name, c.postal_code, c.province_id, p.name AS province
    FROM cities c JOIN provinces p ON p.id = c.province_id ${where} ORDER BY p.name, c.name`, params);
  res.json(rows);
});

router.get('/categories', async (req, res) => {
  const [rows] = await pool.query(`SELECT id, name, description, is_active FROM item_categories
    ${req.query.all ? '' : 'WHERE is_active'} ORDER BY name = 'Other', name`);
  res.json(rows);
});

router.get('/claim-statuses', async (req, res) => {
  const [rows] = await pool.query('SELECT id, code, name, sort_order, is_final FROM claim_statuses ORDER BY sort_order, id');
  res.json(rows);
});

module.exports = router;
