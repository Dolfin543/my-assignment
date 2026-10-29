// Addresses (street number + street + suburb + city) used by persons and offices.
const { fail, text, optionalText, exists } = require('./validate');

// Reads an address from a request body ({ streetNumber, streetName, suburb, cityId }).
// Returns null when every field is empty and the address is optional.
async function readAddress(body, { optional = false, conn } = {}) {
  const empty = ['streetNumber', 'streetName', 'suburb', 'cityId'].every((k) => body[k] === undefined || body[k] === null || String(body[k]).trim() === '');
  if (empty) {
    if (optional) return null;
    fail(400, 'Enter the street number, street name and city.');
  }
  const streetNumber = String(body.streetNumber ?? '').trim();
  if (!/^[0-9]{1,5}[A-Za-z]?$/.test(streetNumber)) fail(400, 'The street number must be a number, optionally followed by a letter (e.g. 12 or 12A).');
  return {
    street_number: streetNumber,
    street_name: text(body.streetName, 'The street name', 2, 100),
    suburb: optionalText(body.suburb, 'The suburb', 80),
    city_id: await exists('cities', body.cityId, 'city', { conn }),
  };
}

// Inserts, updates or removes the address and returns its id (or null).
async function saveAddress(conn, currentId, address) {
  if (!address) {
    return null; // the caller clears its link first, then calls removeAddress
  }
  if (currentId) {
    await conn.query('UPDATE addresses SET ? WHERE id = ?', [address, currentId]);
    return currentId;
  }
  const [r] = await conn.query('INSERT INTO addresses SET ?', [address]);
  return r.insertId;
}

async function removeAddress(conn, id) {
  if (id) await conn.query('DELETE FROM addresses WHERE id = ?', [id]);
}

// SQL snippet for showing an address: "12 Main Road, Southernwood, Mthatha"
const ADDRESS_TEXT = "CONCAT_WS(', ', CONCAT(ad.street_number, ' ', ad.street_name), ad.suburb, ct.name)";

module.exports = { readAddress, saveAddress, removeAddress, ADDRESS_TEXT };
