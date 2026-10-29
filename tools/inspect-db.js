// Prints the live database structure: constraints and indexes.
// Usage: node tools/inspect-db.js
const pool = require('../db/pool');

async function main() {
  const db = process.env.DB_NAME || 'lost_and_found';
  const [constraints] = await pool.query(`
    SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
           GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS cols,
           MAX(k.REFERENCED_TABLE_NAME) AS ref_table,
           cc.CHECK_CLAUSE AS check_clause
    FROM information_schema.TABLE_CONSTRAINTS tc
    LEFT JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA = ?
    GROUP BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE
    ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME`, [db]);
  for (const c of constraints) {
    console.log(`${c.tbl.padEnd(18)} ${c.type.padEnd(12)} ${c.name.padEnd(34)} ${c.cols || ''}${c.ref_table ? ' -> ' + c.ref_table : ''}${c.check_clause ? ' ' + c.check_clause : ''}`);
  }
  const [indexes] = await pool.query(`
    SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
           GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY'
    GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
    ORDER BY TABLE_NAME, INDEX_NAME`, [db]);
  console.log('\nIndexes:');
  for (const i of indexes) {
    console.log(`${i.tbl.padEnd(18)} ${(i.non_unique ? 'INDEX' : 'UNIQUE').padEnd(12)} ${i.name.padEnd(34)} ${i.cols}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
