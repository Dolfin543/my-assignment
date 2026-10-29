// Gives any user a temporary password (e.g. the only admin forgot theirs).
// Other users can also be reset by an administrator in the app.
// Usage: npm run admin:reset-password -- username-or-email
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { makeTempPassword } = require('../lib/accounts');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.log('Usage: npm run admin:reset-password -- username-or-email');
    process.exitCode = 1;
    return;
  }
  const [[user]] = await pool.query("SELECT id, CONCAT(first_name, ' ', last_name) AS full_name FROM persons WHERE email = ? OR username = ?", [email, email]);
  if (!user) {
    console.log(`No account found for ${email}.`);
    process.exitCode = 1;
  } else {
    const temp = makeTempPassword();
    await pool.query('UPDATE persons SET password_hash = ?, must_change_password = TRUE, is_active = TRUE WHERE id = ?',
      [await bcrypt.hash(temp, 10), user.id]);
    console.log(`Temporary password for ${user.full_name} (${email}): ${temp}`);
    console.log('They will be asked to choose a new password when they log in.');
  }
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
