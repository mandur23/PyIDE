// Removes secrets from text written to the IDE log and from the diagnostic data archive: passwords, tokens, API
// keys and safeStorage blobs. Keys whose name says they hold a secret are blanked whatever their value; free text is
// scrubbed of well-known token shapes and of `password=...`-style assignments.
const MASK = '<redacted>';

const SECRET_KEY = /pass(?:word|wd|phrase)?|pwd|secret|token|api[-_. ]?key|apikey|authorization|\bauth\b|auth[-_.]?(?:token|key)|credential|private[-_. ]?key|cookie|session[-_. ]?id|bearer|encrypted|safe[-_. ]?storage|cipher/i;

const TEXT_PATTERNS = [
  // Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Hugging Face, Stripe, npm.
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
// A private server's key, in a Nano Studio join code (whatever it holds) or standing alone with the length of a key:
// key=<key>, key: <key>, "key":"<key>", or a code percent-encoded once or twice inside a URL (%26key%3D<key>).
// A plain key= stays readable: sort keys and map keys are no secret, and a word like monkey= is no key.
const JOIN_KEY = /(nanostudio:(?:\/\/)?join\/?\?(?:[^\s"'`()<>]*&)?key=)[^&\s"'`()<>]+/gi;
const BARE_KEY = /((?:(?<![\w-])|(?<=%(?:25)*(?:26|3F)))["']?key["']?\s*(?:[:=]|%(?:25)*3D)\s*["']?)[A-Za-z0-9_-]{32,}/gi;
// Bearer/Basic auth headers, key=value or "key": "value" assignments, and URL credentials (scheme://user:pass@host).
const AUTH_HEADER =/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// The whole value of a header, whatever its scheme (token abc) or parts (a=1; b=2).
const SECRET_HEADER = /((?:authorization|cookie)["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const ASSIGNMENT = new RegExp(`(["']?[\\w.-]*(?:${SECRET_KEY.source})[\\w.-]*["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}]+)`, 'gi');
// A password can hold spaces where nothing quotes it (a connection string), so it runs to the next delimiter, flag or
// key=value.
const PASSWORD_ASSIGNMENT = /(["']?[\w.-]*(?:pass(?:word|wd|phrase)?|pwd|secret)(?:[-_.][\w.-]*)?["']?\s*[:=]\s*)(?!["'])([^\s,;&}]+(?:[ \t]+(?!-|[\w.-]+=)[^\s,;&}]+)*)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/]+@/gi;
// In a logged command line: --password hunter2, -Password "two words", --api-key abc. The flag's last word has to be
// the name, so --max-tokens 100 or --tokenizer gpt2 stay readable.
const SECRET_FLAG = /((?<![\w-])--?(?:[a-z0-9]+[-_.])*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[-_.]?key|apikey|access[-_.]?key|private[-_.]?key|credentials?|auth|cookie)[ \t]+)("[^"]*"|'[^']*'|[^\s-]\S*)/gi;
// curl -u bob:pw, --user bob:pw, --proxy-user=bob:pw. Numeric ids (docker -u 1000:1000) and C:\... after python -u are not.
const USER_FLAG = /((?<![\w-])(?:-u[ \t]*|--(?:proxy-)?user[ \t=]+)(?!\d+:\d+(?:\s|$))[^\s:/\\]{2,}:)(?![\\/])\S+/g;
// mysql -phunter2: the value hangs on the flag, which means something else to other programs (gcc -pthread,
// pytest -pno:cacheprovider, docker -p8080:80), so elsewhere it has to look like a password: letters and digits.
const MYSQL_PASSWORD = /(\b(?:mysql\w*|mariadb\w*|sshpass)(?:\.exe)?["']?\s(?:[^\r\n]*?\s)?-p[ \t]*)("[^"]*"|'[^']*'|[^\s-]\S*)/gi;
const ATTACHED_PASSWORD = /((?<![\w-])-p)(?=[^\s:=/\\]*[a-z])(?=[^\s:=/\\]*\d)[^\s:=/\\-]\S*/gi;

// Values known to be secret whatever their shape, such as the values loaded from .env files (main/dotenv.js).
// Booleans and short numbers are left alone: masking every "true" in the log would hide nothing worth hiding.
let knownSecrets = [];
function addSecretValues(values) {
  const fresh = values.filter((v) => typeof v === 'string' && v.length >= 4 && !/^(true|false|yes|no|on|off|null|none|\d{1,5})$/i.test(v) && !knownSecrets.includes(v));
  if (fresh.length) knownSecrets = [...knownSecrets, ...fresh].sort((a, b) => b.length - a.length);
}

const assigned = (m, head, value) => (/^["']?(<redacted>|\d*)["']?$/.test(value) ? m : `${head}${MASK}`);

function scrubText(text) {
  let s = String(text);
  for (const v of knownSecrets) if (s.includes(v)) s = s.split(v).join(MASK);
  for (const re of TEXT_PATTERNS) s = s.replace(re, MASK);
  return s
    .replace(JOIN_KEY, `$1${MASK}`)
    .replace(BARE_KEY, `$1${MASK}`)
    .replace(SECRET_HEADER, `$1${MASK}`)
    .replace(AUTH_HEADER, (_m, kind) => `${kind} ${MASK}`)
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(SECRET_FLAG, `$1${MASK}`)
    .replace(USER_FLAG, `$1${MASK}`)
    .replace(MYSQL_PASSWORD, `$1${MASK}`)
    .replace(ATTACHED_PASSWORD, `$1${MASK}`)
    .replace(PASSWORD_ASSIGNMENT, assigned)
    .replace(ASSIGNMENT, assigned);
}

// Text the user typed to run something, which can hold anything; a report only needs to know that it exists.
const TYPED_KEY = /^pyconsole\.history$|(?:^|[.:_-])(?:params|parameters|args|arguments|argv|env|environ|environment|env[-_]?vars?|interp[-_]?options|vm[-_]?options|jvm[-_]?args|command|commandline|cmd)$/i;

// A long unbroken run of base64/hex characters mixing letters and digits: an encrypted blob or a key.
const looksLikeBlob = (s) => s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);

// A deep copy of a settings-like object with every secret replaced by "<redacted>" and what the user typed left out.
function redactObject(value, key = '') {
  if (key && SECRET_KEY.test(key)) return value === '' || value == null ? value : MASK;
  if (Array.isArray(value)) return value.map((v) => redactObject(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !TYPED_KEY.test(k)).map(([k, v]) => [k, redactObject(v, k)]));
  }
  if (typeof value === 'string') return looksLikeBlob(value) || (/^key$/i.test(key) && /^[A-Za-z0-9_-]{32,}$/.test(value)) ? MASK : scrubText(value);
  return value;
}

// Text meant to leave the computer (a GitHub issue): scrubText, and nothing that names the user or their projects.
// - each project folder becomes <project> and the home folder ~, in either slash style, any case, inside file:/// URLs;
// - any other user folder (C:\Users\<name>, /home/<name>, /Users/<name>, /mnt/c/Users/<name>, \\wsl$\<distro>\home\<name>)
//   keeps its parent and shows the name, spaces included, as <user>;
// - e-mail addresses become <email>, and the user (and password) of scheme://user:password@host <user>;
// - the project folder names, and the git repository names passed in `names`, become <project> wherever they stand
//   as a whole word.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function replacePath(text, dir, by) {
  const base = String(dir || '').replace(/[\\/]+$/, '');
  if (base.length < 3) return text;
  const pattern = base.split(/[\\/]+/).map(escapeRe).join('[\\\\/]+');
  return text.replace(new RegExp(`${pattern}(?=[\\\\/]|$|[^\\w.-])`, 'gi'), by);
}
// The name after a Users/home folder: no separator, space or character Windows forbids, except that spaces may stand
// inside it when a separator follows (C:\Users\John Smith\x); otherwise it ends at a space, comma or bracket.
const USER_DIR = /(?<=[\\/])((?:Users|home|Documents and Settings)[\\/]+)(?:[^\\/"'<>:|*?\s](?:[^\\/"'<>:|*?\r\n]*[^\\/"'<>:|*?\s])?(?=[\\/])|[^\\/"'<>:|*?\s,;()]+)/gi;
const URL_USER = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi;
// git@host:owner/repo (an ssh remote) is not an address; package@1.2.3 has no domain.
const EMAIL = /(?<![\w.%+-])(?!git@)[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
// Folder names too common to identify anyone: replacing them would garble the text (the app's own name included).
const GENERIC_NAMES = new Set(['project', 'projects', 'src', 'app', 'apps', 'test', 'tests', 'code', 'python', 'main', 'demo',
  'repo', 'workspace', 'untitled', 'temp', 'tmp', 'home', 'users', 'user', 'desktop', 'documents', 'downloads', 'pyide', 'git']);
const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]+/).pop();
function replaceName(text, name) {
  if (!name || name.length < 3 || GENERIC_NAMES.has(name.toLowerCase())) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_<-])${escapeRe(name)}(?![\\p{L}\\p{N}_>-])`, 'giu'), '<project>');
}

// The repository names of the git remotes in a text (the IDE log): URLs ending in .git, ssh:// and git:// URLs,
// git@host:owner/name, and code-host https URLs on a line that talks about git. The log holds them with the password
// already masked (https://user:<redacted>@host/...).
const REMOTE_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s'"()`]+|[\w.-]+@[\w.-]+:[\w.~-]+\/[^\s'"()`]+)/gi;
const CODE_HOST = /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|dev\.azure\.com)$/i;
const GIT_LINE = /\bgit\b|\b(?:remote|fetch|push|pull|clone|repository)\b/i;
function remoteRepoNames(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    for (const [url] of line.matchAll(REMOTE_URL)) {
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1].toLowerCase();
      if (scheme && !['http', 'https', 'ssh', 'git'].includes(scheme)) continue;
      const after = scheme ? url.slice(scheme.length + 3) : url;
      const host = scheme ? after.split(/[/?#]/)[0].replace(/^.*@/, '').replace(/:\d*$/, '') : after.split('@')[1].split(':')[0];
      const rest = scheme ? after.replace(/^[^/?#]*/, '') : after.slice(after.indexOf(':') + 1);
      const segs = rest.replace(/[?#].*$/, '').replace(/[.,;:!'>]+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      let name = null;
      if (!scheme || scheme === 'ssh' || scheme === 'git' || /\.git$/i.test(last)) name = last;
      else if (CODE_HOST.test(host) && segs.length >= 2 && GIT_LINE.test(line)) name = segs[1];
      name = name && name.replace(/\.git$/i, '');
      if (name && /^[\w.-]+$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

function redactPaths(text, { home, projects = [], names = [] } = {}) {
  let s = String(text);
  const dirs = [...new Set(projects.filter((p) => typeof p === 'string' && p))];
  for (const p of dirs.sort((a, b) => b.length - a.length)) s = replacePath(s, p, '<project>');
  if (home) s = replacePath(s, home, '~');
  s = s.replace(USER_DIR, '$1<user>').replace(URL_USER, '$1<user>@').replace(EMAIL, '<email>');
  const words = [...new Set([...dirs.map(folderName), ...names].filter((n) => typeof n === 'string'))];
  for (const name of words.sort((a, b) => b.length - a.length)) s = replaceName(s, name);
  return scrubText(s);
}

module.exports = { MASK, SECRET_KEY, scrubText, redactObject, addSecretValues, redactPaths, remoteRepoNames };
