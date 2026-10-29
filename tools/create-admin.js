// Creates a system administrator account (or promotes an existing person) with a temporary
// password that must be changed at first login.
// Usage: npm run admin:create -- "First" "Last" admin@example.com [username]
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { makeTempPassword, readNamesAndEmail, readUsername, usernameFromEmail } = require('../lib/accounts');

const USAGE = 'Usage: npm run admin:create -- "First" "Last" admin@example.com [username]';

async function main() {
  const details = readNamesAndEmail({ firstName: process.argv[2], lastName: process.argv[3], email: process.argv[4] });
  if (details.error) {
    console.log(USAGE);
    console.log(details.error);
    process.exitCode = 1;
    return;
  }
  const username = readUsername(process.argv[5] || usernameFromEmail(details.email));
  if (!username) {
    console.log('The username must be 3–30 letters, digits, dots, dashes or underscores.');
    process.exitCode = 1;
    return;
  }
  const temp = makeTempPassword();
  const hash = await bcrypt.hash(temp, 10);
  const [[existing]] = await pool.query('SELECT id, username FROM persons WHERE email = ?', [details.email]);
  let shownUsername = username;
  if (existing) {
    await pool.query("UPDATE persons SET role = 'system_admin', is_active = TRUE, password_hash = ?, must_change_password = TRUE WHERE id = ?",
      [hash, existing.id]);
    await pool.query('DELETE FROM it_admins WHERE person_id = ?', [existing.id]);
    shownUsername = existing.username;
    console.log(`${details.email} already had an account; it is now a system administrator.`);
  } else {
    const [[taken]] = await pool.query('SELECT id FROM persons WHERE username = ?', [username]);
    if (taken) {
      console.log(`The username "${username}" is taken. Add a different one at the end of the command.`);
      process.exitCode = 1;
      await pool.end();
      return;
    }
    await pool.query(`INSERT INTO persons (first_name, last_name, username, email, password_hash, must_change_password, role)
      VALUES (?, ?, ?, ?, ?, TRUE, 'system_admin')`, [details.firstName, details.lastName, username, details.email, hash]);
    console.log(`System administrator account created for ${details.firstName} ${details.lastName}.`);
  }
  console.log(`Username: ${shownUsername}   (or log in with ${details.email})`);
  console.log(`Temporary password: ${temp}`);
  console.log('Log in and choose a new password. This password is not shown again.');
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
