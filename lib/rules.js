// Rules shared by the routes: roles, who may see and change which items and claims,
// the owner/reporter subtypes, photos and the activity log.
const pool = require('../db/pool');
const { fail } = require('./validate');

const isStaff = (user) => user.role === 'office_admin' || user.role === 'system_admin';
const isSystemAdmin = (user) => user.role === 'system_admin';

// The province an office admin works in (lost reports in that province are "their area").
async function officeProvince(officeId, conn = pool) {
  const [[row]] = await conn.query(`
    SELECT c.province_id FROM lost_found_offices o JOIN addresses a ON a.id = o.address_id JOIN cities c ON c.id = a.city_id
    WHERE o.id = ?`, [officeId]);
  return row ? row.province_id : null;
}

// SQL condition (item alias i, lost l, found f, item city ic) for the items a user may see.
//   member        found items that are not closed, and their own lost and found reports
//   office_admin  the same, plus everything of their office and lost items in their province
//   system_admin  everything
// (Seeing is not managing: see canManage.)
async function visibleItemsSql(user) {
  if (isSystemAdmin(user)) return { sql: 'TRUE', params: [] };
  const own = '(l.reporter_id = ? OR l.owner_id = ? OR f.reporter_id = ?)';
  const board = "(i.item_type = 'found' AND i.status <> 'closed')";
  if (user.role === 'office_admin') {
    const provinceId = await officeProvince(user.officeId);
    return {
      sql: `(${board} OR f.lfo_id = ? OR (i.item_type = 'lost' AND ic.province_id = ?) OR ${own})`,
      params: [user.officeId, provinceId, user.id, user.id, user.id],
    };
  }
  return { sql: `(${board} OR ${own})`, params: [user.id, user.id, user.id] };
}

// May this user manage (edit, close, receive, see hidden details of) this item?
async function canManage(user, item) {
  if (isSystemAdmin(user)) return true;
  if (user.role !== 'office_admin') return false;
  if (item.item_type === 'found') return item.lfo_id === user.officeId;
  return item.province_id === await officeProvince(user.officeId);
}

const isOwnReport = (user, item) => item.reporter_id === user.id || item.owner_id === user.id;

// Overlapping subtypes: make sure the person is an owner / a reporter (created when first needed).
async function ensureOwner(conn, personId) {
  await conn.query('INSERT IGNORE INTO owners (person_id) VALUES (?)', [personId]);
}
async function ensureReporter(conn, personId) {
  await conn.query('INSERT IGNORE INTO reporters (person_id) VALUES (?)', [personId]);
}

async function claimStatus(code, conn = pool) {
  const [[s]] = await conn.query('SELECT * FROM claim_statuses WHERE code = ?', [code]);
  if (!s) fail(500, `The claim status "${code}" is missing.`);
  return s;
}

async function log(conn, { personId = null, itemId = null, claimId = null, action, details = null }) {
  await conn.query('INSERT INTO activity_log (person_id, item_id, claim_id, action, details) VALUES (?, ?, ?, ?, ?)',
    [personId, itemId, claimId, action, details ? String(details).slice(0, 500) : null]);
}

// ---------------------------------------------------------------- photos
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_PHOTOS = 3;

function readPhotos(list, alreadyAttached = 0) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(400, 'Photos must be a list.');
  if (list.length + alreadyAttached > MAX_PHOTOS) fail(400, `An item can have at most ${MAX_PHOTOS} photos.`);
  return list.map((p) => {
    if (!PHOTO_TYPES.includes(p.type)) fail(400, 'Photos must be JPEG, PNG or WebP images.');
    const data = Buffer.from(String(p.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (data.length === 0) fail(400, 'One of the photos is empty.');
    if (data.length > MAX_PHOTO_BYTES) fail(400, 'Each photo must be 2 MB or smaller.');
    return { name: String(p.name || 'photo').slice(0, 200), type: p.type, data, isPublic: p.isPublic === undefined ? true : !!p.isPublic };
  });
}

async function savePhotos(conn, itemId, photos) {
  for (const p of photos) {
    await conn.query('INSERT INTO item_photos (item_id, file_name, mime_type, size_bytes, data, is_public) VALUES (?, ?, ?, ?, ?, ?)',
      [itemId, p.name, p.type, p.data.length, p.data, p.isPublic]);
  }
}

module.exports = {
  isStaff, isSystemAdmin, officeProvince, visibleItemsSql, canManage, isOwnReport, ensureOwner, ensureReporter,
  claimStatus, log, MAX_PHOTOS, readPhotos, savePhotos,
};
