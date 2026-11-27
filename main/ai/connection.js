// Which way the AI features reach a model (Settings › AI › Connection): Claude Code (the CLI, signed in with the user's
// Claude account; the default) or an HTTP API with a key (main/ai/api.js). The choice, the address and the model are
// settings (settings.json); the keys are not: they are kept with safeStorage in <userData>/ai-connection/keys.json,
// one per provider, readable only by this Windows account, and never reach the renderer, a log or a command line.
// Without safeStorage a key is kept in memory until the app quits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, safeStorage } = require('electron');

const SETTINGS = { provider: 'aiConnection.provider', openaiUrl: 'aiConnection.openaiUrl', openaiModel: 'aiConnection.openaiModel' };
const DEFAULTS = { provider: 'claude-code', openaiUrl: 'https://api.openai.com/v1', openaiModel: '' };
const PROVIDERS = ['claude-code', 'anthropic', 'openai'];

const keysFile = () => path.join(app.getPath('userData'), 'ai-connection', 'keys.json');
const memory = new Map(); // provider -> key, when safeStorage is not available

function settings() {
  try {
    const text = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    const s = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

function readKeys() {
  try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')) || {}; } catch { return {}; }
}

function keyOf(provider) {
  if (memory.has(provider)) return memory.get(provider);
  const blob = readKeys()[provider];
  if (!blob || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(blob, 'base64')); } catch { return ''; }
}

// key '' forgets it. -> {ok, kept: 'disk' | 'memory' | 'none'}
function setKey(provider, key) {
  if (provider !== 'anthropic' && provider !== 'openai') return { ok: false };
  const value = String(key || '').trim();
  const keys = readKeys();
  memory.delete(provider);
  delete keys[provider];
  let kept = 'none';
  if (value && safeStorage.isEncryptionAvailable()) {
    keys[provider] = safeStorage.encryptString(value).toString('base64');
    kept = 'disk';
  } else if (value) {
    memory.set(provider, value);
    kept = 'memory';
  }
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(keys));
  return { ok: true, kept };
}

// The choice as settings say, or as `over` (the settings page before OK/Apply). -> {provider, openaiUrl, openaiModel}
function choice(over) {
  const s = over ? { [SETTINGS.provider]: over.provider, [SETTINGS.openaiUrl]: over.openaiUrl, [SETTINGS.openaiModel]: over.openaiModel } : settings();
  const provider = PROVIDERS.includes(s[SETTINGS.provider]) ? s[SETTINGS.provider] : DEFAULTS.provider;
  return {
    provider,
    openaiUrl: typeof s[SETTINGS.openaiUrl] === 'string' && s[SETTINGS.openaiUrl].trim() ? s[SETTINGS.openaiUrl].trim() : DEFAULTS.openaiUrl,
    openaiModel: typeof s[SETTINGS.openaiModel] === 'string' ? s[SETTINGS.openaiModel].trim() : DEFAULTS.openaiModel,
  };
}

// The API a request goes to: null for Claude Code, else api.js's cfg (it says itself what is still missing).
function current(over) {
  const c = choice(over);
  if (c.provider === 'claude-code') return null;
  return { provider: c.provider, key: keyOf(c.provider), baseUrl: c.openaiUrl, model: c.openaiModel };
}

// For the settings page: never the key, only whether there is one and its last four characters.
function status() {
  const c = choice();
  const hint = (p) => { const k = keyOf(p); return k ? { has: true, end: k.slice(-4) } : { has: false, end: '' }; };
  return { ...c, keys: { anthropic: hint('anthropic'), openai: hint('openai') }, safeStorage: safeStorage.isEncryptionAvailable() };
}

// The program the Rust Cut starts in place of the Claude Code CLI when an API is chosen: a .cmd beside the CLI's empty
// working folder that runs api-cli.js with this app's executable as Node. Paths with % cannot go in a .cmd. -> path | null
function cliShim() {
  const script = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'api-cli.js');
  if (/[%"\r\n]/.test(process.execPath + script)) return null;
  const dir = path.join(os.tmpdir(), 'pyide-claude');
  const file = path.join(dir, 'nano-studio-api.cmd');
  const text = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" %*\r\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
    return file;
  } catch { return null; }
}

// What the Rust Cut is started with (main/cut-launcher.js): with an API that is set up, the shim as its CLI and the
// connection in its environment (the key in PYIDE_AI_KEY, never an argument). -> {claude?: path | 'none', env: {}}
function forCut() {
  const cfg = current();
  if (!cfg) return { env: {} };
  const env = { CUT_AI_PROVIDER: cfg.provider };
  const ready = cfg.provider === 'anthropic' ? !!cfg.key : !!cfg.model;
  const shim = ready ? cliShim() : null;
  if (!shim) return { claude: 'none', env };
  return {
    claude: shim,
    env: { ...env, PYIDE_AI_CONNECTION: JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model }), PYIDE_AI_KEY: cfg.key || '' },
  };
}

module.exports = { current, status, setKey, choice, forCut, cliShim, SETTINGS, DEFAULTS, PROVIDERS };
