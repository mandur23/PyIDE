// Whether two data source records reach the same server as the same user, so a stored password may stay with the
// record. main/features/database.js (db:save, db:test) and the settings import (archive.js mergeSources) keep a local
// encrypted password for an incoming record with the same id only when this holds: otherwise an edited or imported
// record could send the saved password to another host.
//
// Compared: kind, host (case-insensitive), port, user / username, database / file, and the connection-string fields
// (url, uri) without the credentials in them. A field missing on one side and empty on the other counts as equal.
const URL_FIELDS = ['url', 'uri'];
const FIELDS = ['kind', 'host', 'port', 'user', 'username', 'database', 'file'];

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

function value(record, key) {
  const v = record?.[key];
  if (key === 'host') return text(v).toLowerCase();
  if (key === 'port') return text(v) === '' ? '' : String(Number(v));
  // The user name stays: only the password part is dropped, so a different user is a different connection.
  if (URL_FIELDS.includes(key)) return text(v).replace(/^([a-z][\w+.-]*:\/\/)([^:@/]*):[^@/]*@/i, '$1$2@');
  return text(v);
}

function sameConnection(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return [...FIELDS, ...URL_FIELDS].every((k) => value(a, k) === value(b, k));
}

module.exports = { sameConnection };
