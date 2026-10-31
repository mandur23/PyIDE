const net = require('net');

// The SSL mode of the kinds whose protocol asks the server for TLS on the database port (PostgreSQL, CockroachDB, MySQL,
// MariaDB). Automatic is no stored value at all: a source saved before this setting existed, or one whose host is edited
// later, follows its host instead of keeping a choice made for another server. Off is the only mode that ever sends
// anything in clear text; a server without TLS fails in the other two.

const MODES = new Set(['off', 'require', 'verify']);
const SSL_FIELD = {
  key: 'ssl', label: 'SSL mode', type: 'select',
  options: [['', 'Automatic (Off for this computer, Require otherwise)'], ['off', 'Off'], ['require', 'Require'], ['verify', 'Verify certificate']],
};

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/;
const isLoopback = (host) => !host || LOOPBACK.test(String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''));

const sslMode = (cfg) => (MODES.has(cfg.ssl) ? cfg.ssl : isLoopback(cfg.host) ? 'off' : 'require');

// English here; the database plugin hands over its translations of these exact strings (renderer/features/database).
const NEEDS_NAME = 'Verify certificate needs the server\'s host name, not an IP address, for this database. Enter the host name, or set SSL mode to Require in the data source settings.';
const NO_SSL = 'The server does not support SSL, so the connection was not made and no password was sent. To connect without encryption, set SSL mode to Off in the data source settings.';
const BAD_CERTIFICATE = 'The server\'s SSL certificate could not be verified ({detail}), so the connection was not made and no password was sent. To encrypt without checking the certificate, set SSL mode to Require in the data source settings.';
let dict = {};
const setMessages = (d) => { dict = d || {}; };

// The driver's ssl option, the same shape for pg and mysql2 (pg ignores verifyIdentity: its check follows
// rejectUnauthorized). Verify trusts what Node trusts: its bundled public root certificates. namesOnly: the driver
// compares the certificate with its host only for a name (mysql2 leaves Node to compare an IP address with 'localhost').
function tlsOptions(cfg, { namesOnly = false } = {}) {
  const mode = sslMode(cfg);
  if (mode === 'off') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (namesOnly && net.isIP(String(cfg.host || '').replace(/^\[|\]$/g, ''))) throw new Error(dict[NEEDS_NAME] || NEEDS_NAME);
  return { rejectUnauthorized: true, verifyIdentity: true };
}

const NO_SSL_ERROR = /does not support SSL|does not support secure connection/i;
const CERTIFICATE_CODE = /CERT|SIGNATURE|ALTNAME|HANDSHAKE_SSL_ERROR/;
// What a failed connect should tell the user: the two failures the SSL mode decides name it, others pass through.
function sslFailure(err, cfg) {
  if (NO_SSL_ERROR.test(err.message)) return new Error(dict[NO_SSL] || NO_SSL);
  if (sslMode(cfg) === 'verify' && CERTIFICATE_CODE.test(err.code || '')) {
    return new Error((dict[BAD_CERTIFICATE] || BAD_CERTIFICATE).replace('{detail}', err.message));
  }
  return err;
}

module.exports = { SSL_FIELD, isLoopback, sslMode, tlsOptions, sslFailure, setMessages };
