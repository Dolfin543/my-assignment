// Checks that db/schema.sql (the full creation script) builds exactly the same
// structure as the live database built from the migrations.
// Usage: node tools/compare-schema.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const LIVE = process.env.DB_NAME || 'lost_and_found';
const CHECK = `${LIVE}_schema_check`;

// Everything that defines the structure, as comparable text lines.
async function describe(conn, db) {
  const [cols] = await conn.query(`
    SELECT CONCAT_WS(' ', TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_DEFAULT, '-'), EXTRA) AS line
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`, [db]);
  const [keys] = await conn.query(`
    SELECT CONCAT_WS(' ', k.TABLE_NAME, k.CONSTRAINT_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION),
                     IFNULL(MAX(k.REFERENCED_TABLE_NAME), '-'), IFNULL(MAX(r.DELETE_RULE), '-')) AS line
    FROM information_schema.KEY_COLUMN_USAGE k
    LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME`, [db]);
  const [checks] = await conn.query(`
    SELECT CONCAT_WS(' ', tc.TABLE_NAME, cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE) AS line
    FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
    WHERE cc.CONSTRAINT_SCHEMA = ?`, [db]);
  const [indexes] = await conn.query(`
    SELECT CONCAT_WS(' ', TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) AS line
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`, [db]);
  return new Set([...cols, ...keys, ...checks, ...indexes].map((r) => r.line));
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  const script = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
    .replace(/^﻿/, '') // ignore a byte-order mark some Windows editors add
    .replace(/CREATE DATABASE IF NOT EXISTS lost_and_found;/, `CREATE DATABASE \`${CHECK}\`;`)
    .replace(/USE lost_and_found;/, `USE \`${CHECK}\`;`);
  await conn.query(`DROP DATABASE IF EXISTS \`${CHECK}\``);
  try {
    await conn.query(script);
    const live = await describe(conn, LIVE);
    const fromScript = await describe(conn, CHECK);
    const onlyLive = [...live].filter((l) => !fromScript.has(l));
    const onlyScript = [...fromScript].filter((l) => !live.has(l));
    if (onlyLive.length === 0 && onlyScript.length === 0) {
      console.log(`MATCH: schema.sql and the migrated "${LIVE}" database are identical (${live.size} structural items compared).`);
    } else {
      console.log('DIFFERENCES FOUND');
      onlyLive.forEach((l) => console.log('  only in live DB:   ', l));
      onlyScript.forEach((l) => console.log('  only in schema.sql:', l));
      process.exitCode = 1;
    }
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${CHECK}\``);
    await conn.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
