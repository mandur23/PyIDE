// The Ed25519 key that release signatures are checked against. An installer's <file>.sig on the update feed and
// marketplace/index.json.sig hold a signature of the file's exact bytes in base64 (scripts/signing.mjs writes them).
const crypto = require('crypto');

// Nobody holds this key's private half, so a build that still carries it refuses every signed update and
// scripts/release.mjs stops in step 1. It stays here after PUBLIC_KEY is replaced, to recognise the placeholder.
const PLACEHOLDER = 'MCowBQYDK2VwAyEAdS1cEtTg4zI8dI3MK3w0JuAaCD2v2GSFqmgDdNuWzoE=';

// The base64 line of the public key's PEM (DER SPKI). Replace this line with the real key.
const PUBLIC_KEY = 'MCowBQYDK2VwAyEARw/7lx6Miuusiaz6Xh/sUkBD6hEZ48jCFuUxjbP4mH4=';

const publicKey = () => process.env.PYIDE_RELEASE_PUBLIC_KEY || PUBLIC_KEY;
const isPlaceholder = () => publicKey() === PLACEHOLDER;

// data: the signed bytes. signature: the text of a .sig file. -> Promise<boolean>. Runs on the thread pool: an
// installer is about 100 MB.
function verify(data, signature) {
  const raw = Buffer.from(String(signature).trim(), 'base64');
  if (raw.length !== 64) return Promise.resolve(false);
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey(), 'base64'), format: 'der', type: 'spki' });
  return new Promise((resolve) => { crypto.verify(null, data, key, raw, (err, ok) => resolve(!err && ok)); });
}

module.exports = { publicKey, isPlaceholder, verify };
