// Helpers for person accounts shared by routes and admin tools.
const crypto = require('crypto');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['member', 'office_admin', 'system_admin'];

// No 0/O or 1/l/I, so a temporary password can be read out without confusion.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function makeTempPassword(length = 10) {
  return Array.from(crypto.randomBytes(length), (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

// Returns cleaned { firstName, lastName, email } or { error }.
function readNamesAndEmail(body) {
  const firstName = String(body.firstName || '').trim().slice(0, 60);
  const lastName = String(body.lastName || '').trim().slice(0, 60);
  const email = String(body.email || '').trim().toLowerCase();
  if (!firstName) return { error: 'Enter the first name.' };
  if (!lastName) return { error: 'Enter the last name.' };
  if (!EMAIL_PATTERN.test(email)) return { error: 'Enter a valid email address.' };
  return { firstName, lastName, email };
}

// Usernames: 3–30 lower-case letters, digits, dots, dashes or underscores.
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
function readUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

// A username suggestion from an email address (used by admin:create and the admin page).
function usernameFromEmail(email) {
  return String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30).padEnd(3, '0');
}

// What is kept in the session. officeId is set for office admins (their office).
function toSessionUser(row) {
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name, fullName: `${row.first_name} ${row.last_name}`,
    username: row.username, email: row.email, role: row.role, officeId: row.office_id ?? null,
    mustChangePassword: !!row.must_change_password,
  };
}

module.exports = { EMAIL_PATTERN, USERNAME_PATTERN, ROLES, makeTempPassword, readNamesAndEmail, readUsername, usernameFromEmail, toSessionUser };
