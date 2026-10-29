// Input checks shared by the routes. Each helper returns the cleaned value or throws
// an HttpError, which the error handler in server.js sends back as { error }.
const pool = require('../db/pool');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

// Required text of min–max characters.
function text(value, label, min, max) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) fail(400, `${label} must be ${min}–${max} characters.`);
  return s;
}

// Optional text: returns null when empty.
function optionalText(value, label, max) {
  const s = String(value ?? '').trim();
  if (s.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
  return s || null;
}

// 'YYYY-MM-DD'
function date(value, label) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(400, `Enter a valid ${label}.`);
  return s;
}

// 'YYYY-MM-DDTHH:MM' (from <input type="datetime-local">) -> 'YYYY-MM-DD HH:MM:00'
function dateTime(value, label) {
  const m = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}`))) fail(400, `Enter a valid ${label}.`);
  return `${m[1]} ${m[2]}:00`;
}

// Whole number between min and max. With optional, empty input gives null.
function int(value, label, min, max, { optional = false } = {}) {
  if (optional && (value === '' || value == null)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function oneOf(value, list, label) {
  if (!list.includes(value)) fail(400, `Choose a valid ${label}.`);
  return value;
}

// The id of an existing row in a lookup table, e.g. exists('cities', id, 'city').
// With optional, empty input gives null. activeOnly also requires is_active.
const LOOKUPS = ['provinces', 'cities', 'item_categories', 'claim_statuses', 'lost_found_offices', 'items', 'persons'];
async function exists(table, value, label, { optional = false, activeOnly = false, conn = pool } = {}) {
  if (!LOOKUPS.includes(table)) throw new Error(`exists(): unknown table ${table}`);
  if (optional && (value === '' || value == null)) return null;
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE id = ? ${activeOnly ? 'AND is_active' : ''}`, [value]);
  if (!row) fail(400, `Choose a valid ${label}.`);
  return row.id;
}

// A decimal number between min and max (e.g. a measurement). With optional, empty gives null.
function decimal(value, label, min, max, { optional = false } = {}) {
  if (optional && (value === '' || value == null)) return null;
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < min || n > max) fail(400, `${label} must be a number from ${min} to ${max}.`);
  return n;
}

// Optional map position: both latitude and longitude, or neither.
function position(lat, lng) {
  const empty = (v) => v === '' || v == null;
  if (empty(lat) && empty(lng)) return { latitude: null, longitude: null };
  return { latitude: decimal(lat, 'The latitude', -90, 90), longitude: decimal(lng, 'The longitude', -180, 180) };
}

// Optional South African phone number style: digits, spaces, +, ( ) and -.
function phone(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!/^[0-9+() -]{7,20}$/.test(s)) fail(400, 'Enter a valid phone number (7–20 digits, spaces, +, - or brackets).');
  return s;
}

// 'HH:MM' or 'HH:MM:SS' -> 'HH:MM:00'
function time(value, label) {
  const m = String(value ?? '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/);
  if (!m) fail(400, `Enter a valid ${label} (HH:MM).`);
  return `${m[1]}:${m[2]}:00`;
}

// Runs fn inside a transaction on one connection. If MySQL picks this transaction as the
// victim of a deadlock (possible when many people save at the same moment), the whole
// transaction is rolled back, so it is safe to run it again: up to 3 attempts.
const RETRY_CODES = ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'];
async function inTransaction(fn, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      if (!RETRY_CODES.includes(err.code) || attempt >= attempts) throw err;
    } finally {
      conn.release();
    }
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * attempt));
  }
}

module.exports = { HttpError, fail, text, optionalText, date, dateTime, int, oneOf, exists, decimal, position, phone, time, inTransaction };
