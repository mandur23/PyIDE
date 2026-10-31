// Colab runtimes for notebooks through Google's Colab API (colaboratory.googleapis.com, v1beta): a runtime is a Jupyter
// server on Google's machines (CPU, GPU or TPU) that a notebook's kernel runs on. PyIDE signs in the way Google's own
// Colab CLI does by default: with the Application Default Credentials the user made with gcloud
// (`gcloud auth application-default login --scopes=...`), so PyIDE holds no OAuth client of its own and never sees a
// password. The access token is refreshed from the ADC file's refresh token and kept in memory only. signIn() runs that
// gcloud command for the user (gcloud opens Google's sign-in page in the browser), so nobody has to type it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SCOPES = ['openid', 'https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/colaboratory'];
const LOGIN_ARGS = ['auth', 'application-default', 'login', `--scopes=${SCOPES.join(',')}`];
const LOGIN = `gcloud ${LOGIN_ARGS.join(' ')}`;
const INSTALL_PAGE = 'https://cloud.google.com/sdk/docs/install';
// Tests point these at a stand-in (verify/colab.mjs); PYIDE_GCLOUD is the only gcloud looked for when set.
const API = () => process.env.PYIDE_COLAB_API || 'https://colaboratory.googleapis.com';
const TOKEN_URL = () => process.env.PYIDE_COLAB_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const win = process.platform === 'win32';
// The codes of a sign-in Google no longer takes (the notebook offers to sign in again for these).
const AUTH_CODES = ['noLogin', 'adcType', 'login', 'scope', 'UNAUTHENTICATED', 'http401'];

// A request that never reached Google (offline, DNS, a proxy, a timeout) says so, as code "network".
async function request(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    throw fail(`Could not reach ${new URL(url).host}: ${err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message}`, 'network');
  }
}

// gcloud on PATH, else where Google's installer puts it: a fresh install reaches PATH only in processes started later.
function findGcloud() {
  if (process.env.PYIDE_GCLOUD) return fs.existsSync(process.env.PYIDE_GCLOUD) ? process.env.PYIDE_GCLOUD : null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (win) {
    const sdk = (root) => path.join(root, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin');
    dirs.push(...[process.env.LOCALAPPDATA, process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(sdk));
  } else {
    dirs.push(path.join(os.homedir(), 'google-cloud-sdk', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/lib/google-cloud-sdk/bin', '/snap/bin');
  }
  for (const dir of dirs) {
    const file = path.join(dir, win ? 'gcloud.cmd' : 'gcloud');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// How the user installs gcloud: winget in a terminal tab where it is there, else Google's page. winget.exe is an app
// execution alias, which existsSync reports as missing; lstat sees it.
function install() {
  let winget = false;
  if (win) try { winget = !!fs.lstatSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe')); } catch {}
  return { command: winget ? 'winget install --id Google.CloudSDK -e' : null, page: INSTALL_PAGE };
}

// GOOGLE_APPLICATION_CREDENTIALS, else gcloud's well-known file.
function adcFile() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) : path.join(os.homedir(), '.config');
  return path.join(base, 'gcloud', 'application_default_credentials.json');
}

function readAdc() {
  const file = adcFile();
  let creds;
  try { creds = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (creds?.type !== 'authorized_user' || !creds.refresh_token || !creds.client_id) {
    throw fail(`${file} is not a gcloud user login. Run: ${LOGIN}`, 'adcType');
  }
  return { file, creds };
}

let cached = null; // {key, token, expires}
async function accessToken() {
  const adc = readAdc();
  if (!adc) throw fail(`Sign in to Google with gcloud first: ${LOGIN}`, 'noLogin');
  const key = crypto.createHash('sha256').update(adc.creds.refresh_token).digest('hex');
  if (cached?.key === key && cached.expires - Date.now() > 60000) return { token: cached.token, adc };
  const res = await request(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: adc.creds.refresh_token, client_id: adc.creds.client_id, client_secret: adc.creds.client_secret || '' }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw fail(`Google did not accept the gcloud login (${body.error_description || body.error || res.status}). Sign in again: ${LOGIN}`, 'login');
  }
  const scopes = String(body.scope || '');
  if (scopes && !scopes.includes('auth/colaboratory')) throw fail(`The gcloud login has no Colab permission. Sign in again with the Colab scope: ${LOGIN}`, 'scope');
  // The ID token (the openid scope) names the account; it is only shown, so its signature is not checked.
  let email = '';
  try { email = JSON.parse(Buffer.from(String(body.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch {}
  cached = { key, token: body.access_token, email, expires: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return { token: cached.token, adc };
}

// A Google API request with the signed-in user's token, billed to the ADC file's quota project when it names one.
async function google(method, url, body, label) {
  const { token, adc } = await accessToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (adc.creds.quota_project_id) headers['x-goog-user-project'] = adc.creds.quota_project_id;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await request(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 300) } }; }
  if (!res.ok) {
    const message = data.error?.message || res.statusText;
    // The Colab API takes a gcloud sign-in's requests only with a quota project: a Google Cloud project of the user's
    // with the Colab API turned on, which they are counted against (setUpProject below).
    const code = /quota project/i.test(message) ? 'quotaProject' : data.error?.status || `http${res.status}`;
    throw fail(`${label}: ${message} (${res.status})`, code);
  }
  return data;
}
const call = (method, rel, body) => google(method, `${API()}/${rel}`, body, 'Colab');

// Signed in (as whom, on which plan), or what is in the way: errorCode, with needsSignIn when signing in again is the
// fix (no login, an expired one, one without the Colab scope) rather than the network or Google refusing the account.
async function status() {
  const out = { signedIn: false, login: LOGIN, gcloud: !!findGcloud(), install: install() };
  const failed = (err) => ({ ...out, error: err.message, errorCode: err.code || '', needsSignIn: AUTH_CODES.includes(err.code) });
  let adc;
  try { adc = readAdc(); } catch (err) { return failed(err); }
  if (!adc) return { ...out, errorCode: 'noLogin', needsSignIn: true };
  try {
    const sub = await call('GET', 'v1beta/subscription');
    return { ...out, signedIn: true, tier: sub.tier || 'SUBSCRIPTION_TIER_UNSPECIFIED', email: cached?.email || '' };
  } catch (err) {
    return failed(err);
  }
}

// gcloud's own sign-in, run for the user: it opens Google's page in the browser and waits on localhost for the answer,
// then writes the ADC file. onUrl gets the page's address, for when no browser opened. One at a time: a second call
// ends the first. Resolves true once signed in, false when cancelled.
let signing = null;
function killTree(child) {
  if (child.exitCode !== null) return;
  if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else child.kill();
}
// args are gcloud's own words (no spaces or quotes in them). A .cmd runs through cmd.exe; /s keeps the quoted path and
// the scopes (commas included) as they are.
function startGcloud(args) {
  const gcloud = findGcloud();
  if (!gcloud) throw fail(`The Google Cloud CLI (gcloud) is not installed: ${INSTALL_PAGE}`, 'noGcloud');
  return win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${gcloud}" ${args.join(' ')}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(gcloud, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
function signIn({ onUrl = () => {} } = {}) {
  let child;
  try { child = startGcloud(LOGIN_ARGS); } catch (err) { return Promise.reject(err); }
  cancelSignIn();
  const me = { child, cancelled: false };
  signing = me;
  let output = '';
  let url = null;
  const read = (d) => {
    output = (output + d).slice(-8000);
    const m = !url && /https:\/\/accounts\.google\.com\/\S+/.exec(output);
    if (m) { url = m[0]; onUrl(url); }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  return new Promise((resolve, reject) => {
    child.on('error', (err) => { if (signing === me) signing = null; reject(fail(`Could not start gcloud: ${err.message}`, 'signIn')); });
    child.on('close', (code) => {
      if (signing === me) signing = null;
      if (me.cancelled) return resolve(false);
      let saved = false;
      try { saved = !!readAdc(); } catch {}
      if (code === 0 && saved) { cached = null; return resolve(true); }
      const tail = output.trim().split(/\r?\n/).slice(-6).join('\n');
      reject(fail(`gcloud did not finish the sign-in (exit code ${code})${tail ? `:\n${tail}` : ''}`, 'signIn'));
    });
  });
}
function cancelSignIn() {
  if (!signing) return;
  signing.cancelled = true;
  killTree(signing.child);
  signing = null;
}

// ---------- the quota project ----------
// The Google Cloud projects the user can choose from, and setting one up: created if asked (a project needs the
// account to have accepted Google Cloud's terms once), the Colab API turned on in it, and then made the ADC file's
// quota project with gcloud's own command, which checks the user may use it.
const CRM = () => process.env.PYIDE_COLAB_CRM || 'https://cloudresourcemanager.googleapis.com';
const SERVICE_USAGE = () => process.env.PYIDE_COLAB_SERVICE_USAGE || 'https://serviceusage.googleapis.com';
const CONSOLE = 'https://console.cloud.google.com/';
const projectId = (id) => { if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(id))) throw fail('Not a Google Cloud project ID'); return id; };

async function projects() {
  const data = await google('GET', `${CRM()}/v1/projects?filter=lifecycleState%3AACTIVE&pageSize=200`, null, 'Google Cloud');
  return (data.projects || []).map((p) => ({ projectId: p.projectId, name: p.name || p.projectId }));
}

// A long-running operation, polled until done (Resource Manager's and Service Usage's have no :wait).
async function waitOperation(base, op, label, what) {
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > 3 * 60000) throw fail(`${label}: ${what} did not finish within 3 minutes`);
    await new Promise((r) => setTimeout(r, Number(process.env.PYIDE_COLAB_POLL_MS) || 2000));
    op = await google('GET', `${base}/v1/${op.name}`, null, label);
  }
  if (op.error) throw fail(`${label}: ${op.error.message || `${what} failed`}`, op.error.status || 'operation');
  return op.response || {};
}

function setQuotaProject(id) {
  const child = startGcloud(['auth', 'application-default', 'set-quota-project', projectId(id)]);
  let output = '';
  child.stdout.on('data', (d) => { output = (output + d).slice(-8000); });
  child.stderr.on('data', (d) => { output = (output + d).slice(-8000); });
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(fail(`Could not start gcloud: ${err.message}`, 'quotaProject')));
    child.on('close', (code) => {
      cached = null;
      if (code === 0) return resolve();
      const tail = output.trim().split(/\r?\n/).slice(-6).join('\n');
      return reject(fail(`gcloud could not make ${id} the quota project (exit code ${code})${tail ? `:\n${tail}` : ''}`, 'setQuotaProject'));
    });
  });
}

// id: an existing project, or null for a new "PyIDE Colab" one. onStep names what is happening.
async function setUpProject(id, { onStep = () => {} } = {}) {
  if (!id) {
    id = `pyide-colab-${crypto.randomBytes(3).toString('hex')}`;
    onStep('create', id);
    const op = await google('POST', `${CRM()}/v1/projects`, { projectId: id, name: 'Nano Studio Colab' }, 'Google Cloud');
    await waitOperation(CRM(), op, 'Google Cloud', `Creating ${id}`);
  }
  projectId(id);
  onStep('enable', id);
  const op = await google('POST', `${SERVICE_USAGE()}/v1/projects/${id}/services/colaboratory.googleapis.com:enable`, {}, 'Google Cloud');
  await waitOperation(SERVICE_USAGE(), op, 'Google Cloud', 'Turning on the Colab API');
  onStep('quota', id);
  await setQuotaProject(id);
  return id;
}

const specs = async () => (await call('GET', 'v1beta/runtimespecs')).runtimeSpecs || [];
const runtimes = async () => (await call('GET', 'v1beta/runtimes')).runtimes || [];
const runtimeName = (name) => { if (!/^runtimes\/[a-z0-9-]{1,63}$/.test(String(name))) throw fail('Not a Colab runtime name'); return name; };
const get = (name) => call('GET', `v1beta/${runtimeName(name)}`);
const release = (name) => call('DELETE', `v1beta/${runtimeName(name)}`);

// A new runtime of the spec key {variant, accelerator, shape}: a long-running operation, waited for here.
async function create(key, { onProgress = () => {} } = {}) {
  const runtimeId = `pyide-${crypto.randomBytes(5).toString('hex')}`;
  let op = await call('POST', `v1beta/runtimes?runtimeId=${runtimeId}&requestId=${crypto.randomUUID()}`, { runtimeSpec: key });
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > 10 * 60000) throw fail('Colab did not assign the runtime within 10 minutes');
    onProgress(Math.round((Date.now() - started) / 1000));
    op = await call('GET', `v1/${op.name}:wait`).catch(async (err) => {
      if (err.code === 'http404') throw err;
      await new Promise((r) => setTimeout(r, 3000));
      return call('GET', `v1/${op.name}`);
    });
  }
  if (op.error) throw fail(`Colab: ${op.error.message || 'the runtime could not be assigned'}`, 'create');
  return op.response?.connectionInfo ? op.response : get(`runtimes/${runtimeId}`);
}

module.exports = { status, findGcloud, signIn, cancelSignIn, projects, setUpProject, specs, runtimes, create, get, release, LOGIN, CONSOLE };
