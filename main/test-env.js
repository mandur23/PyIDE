// Which PYIDE_* environment variables an installed copy honours. They are test hooks almost all: a trust-everything
// switch, a replacement release key and update feed, stand-ins for bore, cloudflared, netstat, Java, the launcher, a
// user data folder. An installed copy drops every one of them at startup, before any module reads process.env, unless
// it is started with TEST_SWITCH, which verify/lib.mjs passes to an installed Nano Studio.exe (verify/installed.mjs,
// verify/update-e2e.mjs) and which a variable alone cannot add. Deny by default: a new PYIDE_ variable is a test hook
// until it is listed in USER_SETTINGS. Source runs (the verify suites, development) keep everything.
const TEST_SWITCH = '--pyide-test-env';

// Settings a user or an administrator may set on an installed copy; each only tunes or turns something off.
const USER_SETTINGS = new Set([
  'PYIDE_LOG_LEVEL', // the IDE log's level and size, documented overrides of Help > Debug Log Settings
  'PYIDE_LOG_MAX_BYTES',
  'PYIDE_UPDATE_DIFFERENTIAL', // =0 downloads updates in full; documented off switch for updates.differential
  'PYIDE_SEMANTIC_THREADS', // semantic search sidecar tuning (read by main/semantic/embed_server.py)
  'PYIDE_SEMANTIC_MAX_TOKENS',
  'PYIDE_INSTALL_ROOT', // where the Install Manager puts servers and toolchains instead of ~\.pyide
]);

// env: the object to clean (process.env). Returns the names it removed.
function dropTestEnv({ packaged, argv, env }) {
  if (!packaged || argv.includes(TEST_SWITCH)) return [];
  const dropped = Object.keys(env).filter((k) => /^PYIDE_/i.test(k) && !USER_SETTINGS.has(k.toUpperCase()));
  for (const k of dropped) delete env[k];
  return dropped;
}

module.exports = { TEST_SWITCH, USER_SETTINGS, dropTestEnv };
