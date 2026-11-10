// The Ed25519 key that release signatures are checked against. An installer's <file>.sig on the update feed and
// marketplace/index.json.sig hold a signature of the file's exact bytes in base64 (scripts/signing.mjs writes them).
// An installer's <file>.manifest holds a signed manifest of that installer (below), which updates are checked against.
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

// A signature of the installer's bytes alone lets whoever controls the feed offer an older, genuinely signed installer
// under a higher version in latest.yml (which nobody signs). The manifest binds the file name and version to the bytes:
//   Nano Studio update manifest 1\n<file name>\n<version>\nsha512 <base64 of the installer's SHA-512>\n<signature>\n
// where the signature (base64) covers the four lines before it, newline included. The header keeps a signature made for
// anything else (an installer, the Marketplace index) from reading as a manifest.
const MANIFEST_HEADER = 'Nano Studio update manifest 1';
const manifestBody = (name, version, sha512) => `${MANIFEST_HEADER}\n${name}\n${version}\nsha512 ${sha512}\n`;

// text: a .manifest file. -> Promise<{name, version, sha512}>, or null unless it is well formed and signed by the key.
async function readManifest(text) {
  const lines = String(text).split('\n');
  const [header, name, version, hash, signature, ...rest] = lines;
  if (header !== MANIFEST_HEADER || !name || !version || !/^sha512 [A-Za-z0-9+/]{86}==$/.test(hash || '') || rest.some((l) => l.trim())) return null;
  const sha512 = hash.slice(7);
  return (await verify(Buffer.from(manifestBody(name, version, sha512)), signature)) ? { name, version, sha512 } : null;
}

module.exports = { publicKey, isPlaceholder, verify, manifestBody, readManifest };
