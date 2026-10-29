// Proves the database itself enforces integrity. It creates a small set of its own rows,
// then tries statements that break a rule and checks MySQL rejects each one. Everything
// runs inside one transaction that is rolled back, so no data is left behind.
// Usage: node tools/test-constraints.js
const pool = require('../db/pool');

async function createFixtures(conn) {
  const tag = Date.now().toString(36).slice(-6);
  const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const one = async (sql, params) => (await conn.query(sql, params))[0][0].id;
  const f = { tag };
  f.city = await one("SELECT id FROM cities WHERE name = 'Mthatha'");
  f.province = await one("SELECT id FROM provinces WHERE name = 'Eastern Cape'");
  f.category = await one("SELECT id FROM item_categories WHERE name = 'Phones'");
  f.pending = await one("SELECT id FROM claim_statuses WHERE code = 'pending'");
  f.addr1 = await ins("INSERT INTO addresses (city_id, street_number, street_name) VALUES (?, '1', 'Test Street')", [f.city]);
  f.addr2 = await ins("INSERT INTO addresses (city_id, street_number, street_name) VALUES (?, '2', 'Test Street')", [f.city]);
  f.username = `owner.${tag}`;
  f.email = `owner.${tag}@constraint.test`;
  f.owner = await ins("INSERT INTO persons (address_id, username, first_name, last_name, email, password_hash) VALUES (?, ?, 'Test', 'Owner', ?, 'x')", [f.addr2, f.username, f.email]);
  f.finder = await ins("INSERT INTO persons (username, first_name, last_name, email, password_hash) VALUES (?, 'Test', 'Finder', ?, 'x')", [`finder.${tag}`, `finder.${tag}@constraint.test`]);
  f.admin = await ins("INSERT INTO persons (username, first_name, last_name, email, password_hash, role) VALUES (?, 'Test', 'Admin', ?, 'x', 'office_admin')", [`admin.${tag}`, `admin.${tag}@constraint.test`]);
  await conn.query('INSERT INTO owners (person_id) VALUES (?)', [f.owner]);
  await conn.query('INSERT INTO reporters (person_id) VALUES (?), (?)', [f.owner, f.finder]);
  f.office = await ins("INSERT INTO lost_found_offices (address_id, name, email, phone, lfo_type) VALUES (?, ?, 'desk@mall.test', '047 555 0100', 'mall')", [f.addr1, `Mall ${tag}`]);
  await conn.query("INSERT INTO shopping_malls (lfo_id, desk_location) VALUES (?, 'Customer care desk')", [f.office]);
  await conn.query('INSERT INTO it_admins (lfo_id, person_id) VALUES (?, ?)', [f.office, f.admin]);
  f.lost = await ins("INSERT INTO items (item_type, item_name, category_id, description, city_id) VALUES ('lost', 'Samsung phone', ?, 'Black Samsung in a clear cover', ?)", [f.category, f.city]);
  await conn.query("INSERT INTO lost_items (item_id, reporter_id, owner_id, date_lost) VALUES (?, ?, ?, CURDATE() - INTERVAL 2 DAY)", [f.lost, f.owner, f.owner]);
  f.found = await ins("INSERT INTO items (item_type, item_name, category_id, description, city_id) VALUES ('found', 'Black phone', ?, 'Black phone, clear cover', ?)", [f.category, f.city]);
  await conn.query("INSERT INTO found_items (item_id, reporter_id, lfo_id, found_date, received_at) VALUES (?, ?, ?, CURDATE() - INTERVAL 1 DAY, NOW())", [f.found, f.finder, f.office]);
  f.photo = await ins("INSERT INTO item_photos (item_id, file_name, mime_type, size_bytes, data) VALUES (?, 'a.png', 'image/png', 3, 'abc')", [f.found]);
  f.match = await ins("INSERT INTO matches (lost_item_id, found_item_id, score) VALUES (?, ?, 80)", [f.lost, f.found]);
  f.claim = await ins('INSERT INTO claims (lost_item_id, found_item_id, owner_id, claim_status_id, proof_description) VALUES (?, ?, ?, ?, ?)',
    [f.lost, f.found, f.owner, f.pending, 'Lock screen is my dog, sunflower sticker inside the cover.']);
  f.log = await ins("INSERT INTO activity_log (person_id, item_id, claim_id, action) VALUES (?, ?, ?, 'claim_submitted')", [f.owner, f.found, f.claim]);
  return f;
}

// [description, SQL, expected MySQL error code, or 'OK' when the statement must succeed]
const cases = (f) => [
  // ---- unique keys
  ['UQ: duplicate username (uq_persons_username)', `INSERT INTO persons (username, first_name, last_name, email, password_hash) VALUES ('${f.username}', 'A', 'B', 'dup.${f.tag}@constraint.test', 'x')`, 'ER_DUP_ENTRY'],
  ['UQ: duplicate email (uq_persons_email)', `INSERT INTO persons (username, first_name, last_name, email, password_hash) VALUES ('dup.${f.tag}', 'A', 'B', '${f.email}', 'x')`, 'ER_DUP_ENTRY'],
  ['UQ: two people sharing one address row (uq_persons_address)', `UPDATE persons SET address_id = ${f.addr2} WHERE id = ${f.finder}`, 'ER_DUP_ENTRY'],
  ['UQ: two cities with the same name in a province (uq_cities_province_name)', `INSERT INTO cities (province_id, name, postal_code) VALUES (${f.province}, 'Mthatha', '5100')`, 'ER_DUP_ENTRY'],
  ['UQ: duplicate office name (uq_lost_found_offices_name)', `INSERT INTO lost_found_offices (address_id, name, email, phone, lfo_type) VALUES (${f.addr2}, 'Mall ${f.tag}', 'x@x.test', '047 555 0101', 'mall')`, 'ER_DUP_ENTRY'],
  ['UQ: an office admin of two offices (uq_it_admins_person)', `INSERT INTO it_admins (lfo_id, person_id) VALUES (${f.office}, ${f.admin})`, 'ER_DUP_ENTRY'],
  ['UQ: the same pair suggested twice (uq_matches_lost_found)', `INSERT INTO matches (lost_item_id, found_item_id, score) VALUES (${f.lost}, ${f.found}, 60)`, 'ER_DUP_ENTRY'],
  ['UQ: owner codes are unique (owner_code generated from the person)', `SELECT owner_code FROM owners WHERE person_id = ${f.owner} AND owner_code = CONCAT('OWN-', LPAD(${f.owner}, 6, '0'))`, 'OK'],
  // ---- disjoint and overlapping subtypes
  ['Subtype: a found_items row for a LOST item is refused (fk_found_items_item)', `INSERT INTO found_items (item_id, lfo_id, found_date) VALUES (${f.lost}, ${f.office}, CURDATE())`, 'ER_NO_REFERENCED_ROW_2'],
  ['Subtype: a lost_items row for a FOUND item is refused (fk_lost_items_item)', `INSERT INTO lost_items (item_id, date_lost) VALUES (${f.found}, CURDATE())`, 'ER_NO_REFERENCED_ROW_2'],
  ['Subtype: a subtype row cannot claim the other type (chk_found_items_type)', `INSERT INTO found_items (item_id, item_type, lfo_id, found_date) VALUES (${f.lost}, 'lost', ${f.office}, CURDATE())`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['Subtype: a police_stations row for a MALL office is refused (fk_police_stations_office)', `INSERT INTO police_stations (lfo_id, precinct) VALUES (${f.office}, 'Central')`, 'ER_NO_REFERENCED_ROW_2'],
  ['Subtype: an office type cannot change while its subtype row exists', `UPDATE lost_found_offices SET lfo_type = 'police' WHERE id = ${f.office}`, 'ER_ROW_IS_REFERENCED_2'],
  ['Subtype: overlapping, a person can be owner AND reporter', `SELECT 1 FROM owners o JOIN reporters r ON r.person_id = o.person_id WHERE o.person_id = ${f.owner}`, 'OK'],
  ['FK: a claim by someone who is not an owner (fk_claims_owner)', `INSERT INTO claims (found_item_id, owner_id, claim_status_id, proof_description) VALUES (${f.found}, ${f.finder}, ${f.pending}, 'Some proof that is long enough.')`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK: a lost report by someone who is not a reporter (fk_lost_items_reporter)', `UPDATE lost_items SET reporter_id = ${f.admin} WHERE item_id = ${f.lost}`, 'ER_NO_REFERENCED_ROW_2'],
  // ---- foreign keys
  ['FK: an item in a city that does not exist (fk_items_city)', `UPDATE items SET city_id = 99999999 WHERE id = ${f.lost}`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK: a found item at an office that does not exist (fk_found_items_office)', `UPDATE found_items SET lfo_id = 99999999 WHERE item_id = ${f.found}`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK: an unknown claim status (fk_claims_status)', `UPDATE claims SET claim_status_id = 99999999 WHERE id = ${f.claim}`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK RESTRICT: delete a province that has cities (fk_cities_province)', `DELETE FROM provinces WHERE id = ${f.province}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete a city that is used (fk_addresses_city)', `DELETE FROM cities WHERE id = ${f.city}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete a category in use (fk_items_category)', `DELETE FROM item_categories WHERE id = ${f.category}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete a claim status in use (fk_claims_status)', `DELETE FROM claim_statuses WHERE id = ${f.pending}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete an office that keeps found items (fk_found_items_office)', `DELETE FROM shopping_malls WHERE lfo_id = ${f.office}`, 'OK'],
  ['FK RESTRICT: delete an item while its subtype row exists (fk_found_items_item)', `DELETE FROM items WHERE id = ${f.found}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete an office address in use (fk_lost_found_offices_address)', `DELETE FROM addresses WHERE id = ${f.addr1}`, 'ER_ROW_IS_REFERENCED_2'],
  // ---- checks: people and places
  ['CHECK: username with capitals or spaces (chk_persons_username)', `UPDATE persons SET username = 'Not Valid' WHERE id = ${f.owner}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: invalid email (chk_persons_email)', `UPDATE persons SET email = 'nope' WHERE id = ${f.owner}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: phone with letters (chk_persons_phone)', `UPDATE persons SET phone = 'call me' WHERE id = ${f.owner}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: date of birth before 1900 (chk_persons_dob)', `UPDATE persons SET dob = '1850-01-01' WHERE id = ${f.owner}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: blank first name (chk_persons_first_name)', `UPDATE persons SET first_name = '  ' WHERE id = ${f.owner}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: postal code that is not 4 digits (chk_cities_postal_code)', `UPDATE cities SET postal_code = '51A' WHERE id = ${f.city}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: street number "abc" (chk_addresses_street_number)', `UPDATE addresses SET street_number = 'abc' WHERE id = ${f.addr1}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: office email without @ (chk_lost_found_offices_email)', `UPDATE lost_found_offices SET email = 'desk' WHERE id = ${f.office}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: airport code of 2 letters (chk_airports_iata_code)', `INSERT INTO airports (lfo_id, iata_code) VALUES (${f.office}, 'EL')`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: mall desk location blank (chk_shopping_malls_desk)', `UPDATE shopping_malls SET desk_location = '' WHERE lfo_id = ${f.office}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  // ---- checks: items, matches, claims
  ['CHECK: item name of 1 character (chk_items_name)', `UPDATE items SET item_name = 'X' WHERE id = ${f.lost}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: description shorter than 5 characters (chk_items_description)', `UPDATE items SET description = 'bag' WHERE id = ${f.lost}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: received before it was found (chk_found_items_received)', `UPDATE found_items SET received_at = found_date - INTERVAL 2 DAY WHERE item_id = ${f.found}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: photo of 3 MB (chk_item_photos_size)', `UPDATE item_photos SET size_bytes = 3145728 WHERE id = ${f.photo}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: photo that is a PDF (chk_item_photos_mime)', `UPDATE item_photos SET mime_type = 'application/pdf' WHERE id = ${f.photo}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: match score of 120 (chk_matches_score)', `UPDATE matches SET score = 120 WHERE id = ${f.match}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: confirmed without a decision time (chk_matches_decided)', `UPDATE matches SET match_status = 'confirmed' WHERE id = ${f.match}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: confirmed together with its time is accepted', `UPDATE matches SET match_status = 'confirmed', decided_at = NOW() WHERE id = ${f.match}`, 'OK'],
  ['CHECK: proof description shorter than 20 characters (chk_claims_proof)', `UPDATE claims SET proof_description = 'It is mine' WHERE id = ${f.claim}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: approved_flag other than 1 (chk_claims_approved_flag)', `UPDATE claims SET approved_flag = 2 WHERE id = ${f.claim}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: returned without approval and ID check (chk_claims_restitution)', `UPDATE claims SET restitution_date = NOW() WHERE id = ${f.claim}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: returned with approval and ID check is accepted', `UPDATE claims SET approved_flag = 1, id_verified = TRUE, restitution_date = GREATEST(NOW(), claim_date) WHERE id = ${f.claim}`, 'OK'],
  ['CHECK: decided before it was claimed (chk_claims_reviewed)', `UPDATE claims SET reviewed_at = claim_date - INTERVAL 1 DAY WHERE id = ${f.claim}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: activity action with spaces (chk_activity_log_action)', `UPDATE activity_log SET action = 'Claim Submitted' WHERE id = ${f.log}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  // ---- enums and not null
  ['ENUM: unknown role', `UPDATE persons SET role = 'mayor' WHERE id = ${f.owner}`, 'WARN_DATA_TRUNCATED'],
  ['ENUM: unknown item status', `UPDATE items SET status = 'lost_forever' WHERE id = ${f.lost}`, 'WARN_DATA_TRUNCATED'],
  ['ENUM: unknown office type', `UPDATE lost_found_offices SET lfo_type = 'train' WHERE id = ${f.office}`, 'WARN_DATA_TRUNCATED'],
  ['NOT NULL: an item without a city', `INSERT INTO items (item_type, item_name, category_id, description) VALUES ('lost', 'Keys', ${f.category}, 'Car keys on a ring')`, 'ER_NO_DEFAULT_FOR_FIELD'],
];

async function main() {
  const conn = await pool.getConnection();
  let passed = 0;
  let total = 0;
  const record = (ok, text) => { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };
  try {
    await conn.beginTransaction();
    const f = await createFixtures(conn);

    // Only one successful claim per found item (uq_claims_found_approved).
    await conn.query('SAVEPOINT test_case');
    let got = 'OK';
    try {
      await conn.query('UPDATE claims SET approved_flag = 1 WHERE id = ?', [f.claim]);
      await conn.query('INSERT INTO claims (found_item_id, owner_id, claim_status_id, proof_description, approved_flag) VALUES (?, ?, ?, ?, 1)',
        [f.found, f.owner, f.pending, 'A second claim that should not be approved.']);
    } catch (err) { got = err.code; }
    await conn.query('ROLLBACK TO SAVEPOINT test_case');
    record(got === 'ER_DUP_ENTRY', `UQ: two approved claims on one found item (uq_claims_found_approved)  ->  ${got === 'OK' ? 'ACCEPTED' : got}`);

    // Only one confirmed match per item (uq_matches_confirmed_found).
    await conn.query('SAVEPOINT test_case');
    got = 'OK';
    try {
      const lost2 = (await conn.query("INSERT INTO items (item_type, item_name, category_id, description, city_id) VALUES ('lost', 'Black phone', ?, 'Another black phone', ?)", [f.category, f.city]))[0].insertId;
      await conn.query('INSERT INTO lost_items (item_id, reporter_id, owner_id, date_lost) VALUES (?, ?, ?, CURDATE())', [lost2, f.owner, f.owner]);
      await conn.query("UPDATE matches SET match_status = 'confirmed', decided_at = NOW() WHERE id = ?", [f.match]);
      await conn.query("INSERT INTO matches (lost_item_id, found_item_id, score, match_status, decided_at) VALUES (?, ?, 70, 'confirmed', NOW())", [lost2, f.found]);
    } catch (err) { got = err.code; }
    await conn.query('ROLLBACK TO SAVEPOINT test_case');
    record(got === 'ER_DUP_ENTRY', `UQ: two confirmed matches for one found item (uq_matches_confirmed_found)  ->  ${got === 'OK' ? 'ACCEPTED' : got}`);

    for (const [name, sql, expected] of cases(f)) {
      await conn.query('SAVEPOINT test_case');
      got = 'OK';
      try {
        const [rows] = await conn.query(sql);
        if (/^SELECT/.test(sql) && (!Array.isArray(rows) || rows.length === 0)) got = 'NO_ROWS';
      } catch (err) { got = err.code; }
      await conn.query('ROLLBACK TO SAVEPOINT test_case');
      record(got === expected, `${name}  ->  ${got === 'OK' ? 'ACCEPTED' : got}`);
    }

    // Deleting a person keeps their reports and claims (SET NULL) but removes their owner/reporter rows (CASCADE).
    await conn.query('SAVEPOINT test_case');
    await conn.query('DELETE FROM persons WHERE id = ?', [f.owner]);
    const [[kept]] = await conn.query(`SELECT (SELECT COUNT(*) FROM lost_items WHERE item_id = ? AND owner_id IS NULL AND reporter_id IS NULL) AS lost_kept,
      (SELECT COUNT(*) FROM claims WHERE id = ? AND owner_id IS NULL) AS claim_kept,
      (SELECT COUNT(*) FROM owners WHERE person_id = ?) + (SELECT COUNT(*) FROM reporters WHERE person_id = ?) AS subtypes_left`, [f.lost, f.claim, f.owner, f.owner]);
    await conn.query('ROLLBACK TO SAVEPOINT test_case');
    record(kept.lost_kept === 1 && kept.claim_kept === 1, `FK SET NULL: deleting a person keeps their lost report and claim  ->  ${kept.lost_kept && kept.claim_kept ? 'KEPT' : 'LOST'}`);
    record(kept.subtypes_left === 0, `FK CASCADE: deleting a person removes their owner and reporter rows  ->  ${kept.subtypes_left === 0 ? 'CASCADED' : 'ROWS_LEFT'}`);

    // Deleting a found item (subtype first) removes its photos, matches and claims.
    await conn.query('DELETE FROM found_items WHERE item_id = ?', [f.found]);
    await conn.query('DELETE FROM items WHERE id = ?', [f.found]);
    const [[left]] = await conn.query(`SELECT (SELECT COUNT(*) FROM item_photos WHERE item_id = ?) + (SELECT COUNT(*) FROM matches WHERE found_item_id = ?)
      + (SELECT COUNT(*) FROM claims WHERE found_item_id = ?) AS n, (SELECT item_id FROM activity_log WHERE id = ?) AS log_item`, [f.found, f.found, f.found, f.log]);
    record(left.n === 0 && left.log_item === null, `FK CASCADE / SET NULL: deleting a found item removes photos, matches, claims; the log keeps the entry  ->  ${left.n === 0 ? 'CASCADED' : 'ROWS_LEFT'}`);
  } finally {
    await conn.rollback(); // removes every row this test created
    conn.release();
    await pool.end();
  }
  console.log(`\n${passed}/${total} integrity rules enforced by MySQL (all test rows rolled back).`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
