// Claims: an owner claims a found item and describes identifying details; an admin of the office
// keeping the item compares them with the hidden details, approves or rejects, and records the
// return when the owner collects it (after checking their ID).
//   pending -> under_review -> approved -> returned
//                           -> rejected        (or withdrawn by the owner while not yet decided)
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, optionalText, oneOf, inTransaction } = require('../lib/validate');
const { isSystemAdmin, ensureOwner, claimStatus, log } = require('../lib/rules');

const router = express.Router();
const staffOnly = requireRole('office_admin', 'system_admin');

const SELECT = `
  SELECT c.id, c.claim_date, c.proof_description, c.reviewed_at, c.decision_notes, c.restitution_date, c.id_verified,
         c.owner_id, c.lost_item_id, c.found_item_id, cs.code AS status_code, cs.name AS status, cs.is_final,
         fi.item_name, fi.status AS item_status, f.found_ref, f.lfo_id, f.received_at, o.name AS office_name, cat.name AS category,
         l.lost_ref, CONCAT(p.first_name, ' ', p.last_name) AS claimant, p.email AS claimant_email, p.phone AS claimant_phone,
         CONCAT(rv.first_name, ' ', rv.last_name) AS reviewed_by_name, CONCAT(rl.first_name, ' ', rl.last_name) AS released_by_name,
         (SELECT COUNT(*) FROM claims c2 JOIN claim_statuses s2 ON s2.id = c2.claim_status_id
          WHERE c2.owner_id = c.owner_id AND s2.code = 'rejected') AS rejected_claims
  FROM claims c
  JOIN claim_statuses cs ON cs.id = c.claim_status_id
  JOIN found_items f ON f.item_id = c.found_item_id
  JOIN items fi ON fi.id = f.item_id
  JOIN item_categories cat ON cat.id = fi.category_id
  JOIN lost_found_offices o ON o.id = f.lfo_id
  LEFT JOIN lost_items l ON l.item_id = c.lost_item_id
  LEFT JOIN persons p ON p.id = c.owner_id
  LEFT JOIN persons rv ON rv.id = c.reviewed_by
  LEFT JOIN persons rl ON rl.id = c.released_by`;

// Members see their own claims; office admins the claims on their office's items; the system admin all.
function scope(user) {
  if (user.role === 'member') return { sql: 'c.owner_id = ?', params: [user.id] };
  if (user.role === 'office_admin') return { sql: '(f.lfo_id = ? OR c.owner_id = ?)', params: [user.officeId, user.id] };
  return { sql: 'TRUE', params: [] };
}

router.get('/', requireLogin, async (req, res) => {
  const s = scope(req.session.user);
  const where = [s.sql];
  const params = [...s.params];
  if (req.query.status) { where.push('cs.code = ?'); params.push(req.query.status); }
  if (req.query.open === '1') where.push("cs.code IN ('pending', 'under_review', 'approved')");
  if (req.query.officeId) { where.push('f.lfo_id = ?'); params.push(req.query.officeId); }
  if (req.query.mine === '1') { where.push('c.owner_id = ?'); params.push(req.session.user.id); }
  if (req.query.q) {
    const like = `%${req.query.q}%`;
    where.push("(fi.item_name LIKE ? OR f.found_ref = ? OR CONCAT(p.first_name, ' ', p.last_name) LIKE ?)");
    params.push(like, String(req.query.q).toUpperCase(), like);
  }
  const [rows] = await pool.query(`${SELECT} WHERE ${where.join(' AND ')}
    ORDER BY cs.sort_order, c.claim_date DESC LIMIT 300`, params);
  res.json(rows);
});

async function loadClaim(user, id, conn = pool, lock = false) {
  const s = scope(user);
  const [[claim]] = await conn.query(`${SELECT} WHERE c.id = ? AND ${s.sql} ${lock ? 'FOR UPDATE OF c' : ''}`, [id, ...s.params]);
  if (!claim) fail(404, 'Claim not found.');
  return claim;
}

const canDecide = (user, claim) => isSystemAdmin(user) || (user.role === 'office_admin' && claim.lfo_id === user.officeId);

router.get('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const claim = await loadClaim(user, req.params.id);
  const manage = canDecide(user, claim);
  const result = { ...claim, canDecide: manage, isOwn: claim.owner_id === user.id };
  if (manage) {
    const [[f]] = await pool.query('SELECT hidden_details FROM found_items WHERE item_id = ?', [claim.found_item_id]);
    result.hidden_details = f.hidden_details;
    const [activity] = await pool.query(`SELECT a.action, a.details, a.created_at, CONCAT(p.first_name, ' ', p.last_name) AS person
      FROM activity_log a LEFT JOIN persons p ON p.id = a.person_id WHERE a.claim_id = ? ORDER BY a.created_at DESC, a.id DESC`, [claim.id]);
    result.activity = activity;
  } else {
    result.rejected_claims = undefined;
  }
  res.json(result);
});

// Submit a claim. The finder can't claim the item they handed in; one open claim per person per item.
router.post('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const proof = text(req.body.proofDescription, 'The description of your item', 20, 2000);
  const id = await inTransaction(async (conn) => {
    const [[found]] = await conn.query(`SELECT f.item_id, f.reporter_id, f.lfo_id, i.status, i.item_name FROM found_items f JOIN items i ON i.id = f.item_id
      WHERE f.item_id = ? FOR UPDATE`, [req.body.foundItemId]);
    if (!found) fail(400, 'Choose a found item to claim.');
    if (!['open', 'matched'].includes(found.status)) fail(409, 'This item can no longer be claimed.');
    if (found.reporter_id === user.id) fail(409, 'You reported finding this item, so you cannot claim it.');
    if (user.role === 'office_admin' && user.officeId === found.lfo_id) fail(409, 'Staff of the office keeping an item cannot claim it.');
    const [[open]] = await conn.query(`SELECT c.id FROM claims c JOIN claim_statuses s ON s.id = c.claim_status_id
      WHERE c.found_item_id = ? AND c.owner_id = ? AND s.code IN ('pending', 'under_review', 'approved')`, [found.item_id, user.id]);
    if (open) fail(409, 'You already have an open claim on this item.');
    let lostItemId = null;
    if (req.body.lostItemId) {
      const [[lost]] = await conn.query('SELECT item_id FROM lost_items WHERE item_id = ? AND owner_id = ?', [req.body.lostItemId, user.id]);
      if (!lost) fail(400, 'Choose one of your own lost-item reports.');
      lostItemId = lost.item_id;
    }
    await ensureOwner(conn, user.id);
    const pending = await claimStatus('pending', conn);
    const [r] = await conn.query('INSERT INTO claims (lost_item_id, found_item_id, owner_id, claim_status_id, proof_description) VALUES (?, ?, ?, ?, ?)',
      [lostItemId, found.item_id, user.id, pending.id, proof]);
    await log(conn, { personId: user.id, itemId: found.item_id, claimId: r.insertId, action: 'claim_submitted' });
    return r.insertId;
  });
  res.status(201).json({ id });
});

// The owner withdraws a claim that has not been decided yet.
router.post('/:id/withdraw', requireLogin, async (req, res) => {
  const user = req.session.user;
  await inTransaction(async (conn) => {
    const claim = await loadClaim(user, req.params.id, conn, true);
    if (claim.owner_id !== user.id) fail(403, 'You can only withdraw your own claims.');
    if (!['pending', 'under_review'].includes(claim.status_code)) fail(409, 'Only a claim that has not been decided can be withdrawn.');
    const withdrawn = await claimStatus('withdrawn', conn);
    await conn.query('UPDATE claims SET claim_status_id = ? WHERE id = ?', [withdrawn.id, claim.id]);
    await log(conn, { personId: user.id, itemId: claim.found_item_id, claimId: claim.id, action: 'claim_withdrawn' });
  });
  res.json({ ok: true });
});

// An office admin decides: review (start checking), approve or reject.
router.post('/:id/decision', staffOnly, async (req, res) => {
  const user = req.session.user;
  const decision = oneOf(req.body.decision, ['review', 'approve', 'reject'], 'decision');
  const notes = decision === 'reject' ? text(req.body.notes, 'The reason for rejecting', 5, 1000) : optionalText(req.body.notes, 'The notes', 1000);
  try {
    await inTransaction(async (conn) => {
      const claim = await loadClaim(user, req.params.id, conn, true);
      if (!canDecide(user, claim)) fail(403, 'This item is kept by another office.');
      if (!['pending', 'under_review'].includes(claim.status_code)) fail(409, `This claim is already ${claim.status.toLowerCase()}.`);
      if (decision === 'review') {
        if (claim.status_code === 'under_review') fail(409, 'This claim is already under review.');
        await conn.query('UPDATE claims SET claim_status_id = ? WHERE id = ?', [(await claimStatus('under_review', conn)).id, claim.id]);
        await log(conn, { personId: user.id, itemId: claim.found_item_id, claimId: claim.id, action: 'claim_review_started' });
        return;
      }
      if (decision === 'approve') {
        if (!claim.received_at) fail(409, 'The office has not received this item yet. Mark it received first.');
        if (!['open', 'matched'].includes(claim.item_status)) fail(409, 'This item can no longer be claimed.');
        await conn.query('SELECT item_id FROM found_items WHERE item_id = ? FOR UPDATE', [claim.found_item_id]);
        await conn.query('UPDATE claims SET claim_status_id = ?, approved_flag = 1, reviewed_by = ?, reviewed_at = NOW(), decision_notes = ? WHERE id = ?',
          [(await claimStatus('approved', conn)).id, user.id, notes, claim.id]);
        await conn.query("UPDATE items SET status = 'claimed' WHERE id = ?", [claim.found_item_id]);
        if (claim.lost_item_id) await conn.query("UPDATE items SET status = 'claimed' WHERE id = ? AND status IN ('open', 'matched')", [claim.lost_item_id]);
        // Other open claims on the same item are rejected.
        const rejected = await claimStatus('rejected', conn);
        await conn.query(`UPDATE claims c JOIN claim_statuses s ON s.id = c.claim_status_id
          SET c.claim_status_id = ?, c.reviewed_by = ?, c.reviewed_at = NOW(), c.decision_notes = 'Another claim on this item was approved.'
          WHERE c.found_item_id = ? AND c.id <> ? AND s.code IN ('pending', 'under_review')`, [rejected.id, user.id, claim.found_item_id, claim.id]);
        await log(conn, { personId: user.id, itemId: claim.found_item_id, claimId: claim.id, action: 'claim_approved', details: notes });
      } else {
        await conn.query('UPDATE claims SET claim_status_id = ?, reviewed_by = ?, reviewed_at = NOW(), decision_notes = ? WHERE id = ?',
          [(await claimStatus('rejected', conn)).id, user.id, notes, claim.id]);
        await log(conn, { personId: user.id, itemId: claim.found_item_id, claimId: claim.id, action: 'claim_rejected', details: notes });
      }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') fail(409, 'Another claim on this item has already been approved.');
    throw err;
  }
  res.json({ ok: true });
});

// The owner collected the item: the office checked their ID and hands it over.
router.post('/:id/return', staffOnly, async (req, res) => {
  const user = req.session.user;
  if (req.body.idVerified !== true) fail(400, 'Check the owner\'s ID document before handing the item over.');
  await inTransaction(async (conn) => {
    const claim = await loadClaim(user, req.params.id, conn, true);
    if (!canDecide(user, claim)) fail(403, 'This item is kept by another office.');
    if (claim.status_code !== 'approved') fail(409, 'Only an approved claim can be handed over.');
    await conn.query('UPDATE claims SET claim_status_id = ?, id_verified = TRUE, restitution_date = GREATEST(NOW(), claim_date), released_by = ? WHERE id = ?',
      [(await claimStatus('returned', conn)).id, user.id, claim.id]);
    await conn.query("UPDATE items SET status = 'returned' WHERE id = ?", [claim.found_item_id]);
    if (claim.lost_item_id) await conn.query("UPDATE items SET status = 'returned' WHERE id = ?", [claim.lost_item_id]);
    await log(conn, { personId: user.id, itemId: claim.found_item_id, claimId: claim.id, action: 'item_returned', details: optionalText(req.body.notes, 'The notes', 300) });
  });
  res.json({ ok: true });
});

module.exports = router;
