const pool = require('../db/pool');
const { toSessionUser } = require('./accounts');

// Re-reads the logged-in person from the database on every request, so a role change,
// office change or deactivation by an administrator takes effect immediately.
async function loadUser(req, res, next) {
  if (!req.session.user) return next();
  const [[row]] = await pool.query(`
    SELECT p.id, p.first_name, p.last_name, p.username, p.email, p.role, p.must_change_password, p.is_active, a.lfo_id AS office_id
    FROM persons p LEFT JOIN it_admins a ON a.person_id = p.id
    WHERE p.id = ?`, [req.session.user.id]);
  if (!row || !row.is_active) {
    return req.session.destroy(() => res.status(401).json({ error: 'Your session has ended. Please log in again.' }));
  }
  req.session.user = toSessionUser(row);
  next();
}

// Logged in at all (used by the routes needed to change a temporary password).
function requireSession(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

// Logged in, and not still using a temporary password.
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.session.user.mustChangePassword) {
    return res.status(403).json({ error: 'Please choose a new password first.', mustChangePassword: true });
  }
  next();
}

// Logged in with one of the given roles. An office admin must also be assigned to an office.
function requireRole(...roles) {
  return (req, res, next) => requireLogin(req, res, () => {
    const user = req.session.user;
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'You are not allowed to do this.' });
    if (user.role === 'office_admin' && !user.officeId) {
      return res.status(403).json({ error: 'You are not assigned to a lost-and-found office yet. Ask the system administrator.' });
    }
    next();
  });
}

module.exports = { loadUser, requireSession, requireLogin, requireRole };
