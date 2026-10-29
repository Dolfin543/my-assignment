// Suggests matches between lost and found items. Run after an item is reported or edited.
// A pair is considered when it has the same category, is in the same province, and the item
// was found from one day before it was lost up to 60 days after. Score (0-100):
//   same category 40 · same city 15 · dates close together up to 20 ·
//   shared words in the name and description up to 20 · same colour 5 (or brand 5)
// Pairs scoring at least MIN_SCORE are stored as "suggested"; an office admin confirms or rejects them.
const MIN_SCORE = 55;

const STOP_WORDS = new Set(['the', 'and', 'with', 'for', 'was', 'were', 'has', 'have', 'had', 'from', 'that', 'this', 'near',
  'inside', 'outside', 'small', 'large', 'big', 'old', 'new', 'some', 'one', 'two', 'lost', 'found', 'left', 'item', 'its', 'not',
  'are', 'but', 'there', 'they', 'which', 'when', 'where', 'into', 'over', 'very', 'colour', 'color']);

function words(...texts) {
  return new Set(texts.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)));
}

function score(lost, found) {
  if (lost.category_id !== found.category_id) return 0;
  let s = 40;
  if (lost.city_id === found.city_id) s += 15;
  const gap = Math.abs((new Date(found.found_date) - new Date(lost.date_lost)) / 864e5);
  s += gap <= 1 ? 20 : gap <= 3 ? 15 : gap <= 7 ? 10 : gap <= 21 ? 5 : 0;
  const a = words(lost.item_name, lost.description, lost.brand || '');
  const b = words(found.item_name, found.description, found.brand || '');
  const shared = [...a].filter((w) => b.has(w)).length;
  s += Math.min(20, shared * 5);
  const same = (x, y) => x && y && x.trim().toLowerCase() === y.trim().toLowerCase();
  if (same(lost.colour, found.colour)) s += 5;
  else if (same(lost.brand, found.brand)) s += 5;
  return Math.min(100, s);
}

const ITEM_SQL = `
  SELECT i.id, i.item_type, i.item_name, i.category_id, i.description, i.colour, i.brand, i.city_id, i.status,
         c.province_id, l.date_lost, f.found_date
  FROM items i
  JOIN cities c ON c.id = i.city_id
  LEFT JOIN lost_items l ON l.item_id = i.id
  LEFT JOIN found_items f ON f.item_id = i.id`;

// Finds and stores suggestions for one item. Returns how many suggestions it now has.
async function suggestMatches(conn, itemId) {
  const [[item]] = await conn.query(`${ITEM_SQL} WHERE i.id = ?`, [itemId]);
  if (!item || !['open', 'matched'].includes(item.status)) return 0;
  const other = item.item_type === 'lost' ? 'found' : 'lost';
  const [candidates] = await conn.query(`${ITEM_SQL}
    WHERE i.item_type = ? AND i.status IN ('open', 'matched') AND i.category_id = ? AND c.province_id = ?
      AND ${other === 'found'
    ? 'f.found_date BETWEEN ? - INTERVAL 1 DAY AND ? + INTERVAL 60 DAY'
    : 'l.date_lost BETWEEN ? - INTERVAL 60 DAY AND ? + INTERVAL 1 DAY'}`,
  [other, item.category_id, item.province_id,
    item.item_type === 'lost' ? item.date_lost : item.found_date, item.item_type === 'lost' ? item.date_lost : item.found_date]);
  let count = 0;
  for (const c of candidates) {
    const [lost, found] = item.item_type === 'lost' ? [item, c] : [c, item];
    const s = score(lost, found);
    if (s < MIN_SCORE) continue;
    // A decided pair (confirmed or rejected) keeps its decision; a suggestion gets the new score.
    await conn.query(`INSERT INTO matches (lost_item_id, found_item_id, score) VALUES (?, ?, ?) AS n
      ON DUPLICATE KEY UPDATE score = IF(matches.match_status = 'suggested', n.score, matches.score)`, [lost.id, found.id, s]);
    count++;
  }
  return count;
}

module.exports = { suggestMatches, score, MIN_SCORE };
