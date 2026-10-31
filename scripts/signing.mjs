// Signs release files with the private half of main/release-key.js: scripts/release.mjs the installers,
// scripts/marketplace.mjs the Marketplace index.
import { createPrivateKey, createPublicKey, sign } from 'crypto';
import { createRequire } from 'module';
import { homedir } from 'os';
import path from 'path';

const release = createRequire(import.meta.url)('../main/release-key.js');

export const keyFile = (env = process.env) => env.NANO_RELEASE_KEY || path.join(env.USERPROFILE || homedir(), '.nano-studio', 'release-key.pem');

// Returns (bytes) => the text of a .sig file. A key that does not match the embedded public key is refused here,
// because its signatures would make every installed copy refuse the release. fsLike: {existsSync, readFileSync}.
export function loadSigner(fsLike, file = keyFile()) {
  if (!fsLike.existsSync(file)) throw new Error(`no release signing key at ${file}: put the Ed25519 private key (PEM) there or name it with NANO_RELEASE_KEY`);
  let key;
  try { key = createPrivateKey(fsLike.readFileSync(file)); } catch (err) { throw new Error(`${file} is not a readable private key (${err.message})`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is a ${key.asymmetricKeyType} key; release signing uses Ed25519`);
  if (createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== release.publicKey()) {
    throw new Error(`${file} does not match the public key in main/release-key.js${release.isPlaceholder() ? ', which is still the placeholder' : ''}`);
  }
  return (bytes) => `${sign(null, Buffer.from(bytes), key).toString('base64')}\n`;
}
