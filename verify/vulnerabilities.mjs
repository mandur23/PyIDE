// Vulnerable packages: a fake OSV server (node http, PYIDE_OSV_URL) knows two advisories for pyide-vuln-demo 1.0,
// installed in a temp project venv from a tiny offline wheel (as verify/deps.mjs does) and pinned in requirements.txt.
// Checks the ⚠ in the Python Packages window, the advisory details, the requirement squiggle with its hover, the
// Problems entry, the quick fix that edits the pin (and keeps ~=, extras, markers, continuations and comments; none
// for a clause that excludes the fix or for --hash lines), Upgrade (pip install of the offline 1.1 wheel), the 24 h cache
// (requests counted at the fake server, also across a restart), the server being down, the setting off, Safe Mode,
// and the Korean UI. Nothing reaches osv.dev or PyPI. Ports 9220-9229 (CDP 9220/9221, fake OSV 9228).
// First, without Electron: the quick fix's requirement rewrite (main/packages/osv.js) case by case, and the cache
// file (main/features/vulnerabilities.js) when it is damaged. `node verify/vulnerabilities.mjs --unit` runs only those.
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;

// requirements.txt texts for the quick fix in the IDE (raw: the requirement as main/packages/deps.js reads it).
const E2E_COMPATIBLE = {
  file: '# Compatible releases\npyide-vuln-demo[extra] ~= 1.0 \\\n    ; python_version >= "3"  # stays on 1.x\n',
  raw: 'pyide-vuln-demo[extra] ~= 1.0      ; python_version >= "3"',
  fixedFile: '# Compatible releases\npyide-vuln-demo[extra] ~= 1.0, >= 1.1 \\\n    ; python_version >= "3"  # stays on 1.x\n',
};
const E2E_EXCLUDED = { file: 'pyide-vuln-demo~=1.0.0  # 1.0.x only\n', raw: 'pyide-vuln-demo~=1.0.0' };
const E2E_HASHED = { file: `pyide-vuln-demo==1.0 \\\n    --hash=sha256:${'0'.repeat(64)}\n`, raw: 'pyide-vuln-demo==1.0' };

// ---------- pure Node ----------
{
  const require = createRequire(import.meta.url);
  const osv = require('../main/packages/osv.js');
  const deps = require('../main/packages/deps.js');
  const vulnerabilities = require('../main/features/vulnerabilities.js');
  const unit = [];
  const ok = (cond, msg) => { unit.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };

  // [requirement as written, fixed version, quick fix text or null (no quick fix)]
  const HASH = `sha256:${'0'.repeat(64)}`;
  const REWRITES = [
    ['django~=3.2.0', '3.2.25', 'django~=3.2.0,>=3.2.25'], // not django>=3.2.25, which installs Django 5
    ['django ~= 3.2.0', '3.2.25', 'django ~= 3.2.0, >= 3.2.25'],
    ['django~=3.1.0', '3.2.25', null], // the declared compatibility excludes the fix
    ['django~=3.2', '3.2.25', 'django~=3.2,>=3.2.25'],
    ['django==3.2.*', '3.2.25', 'django==3.2.*,>=3.2.25'],
    ['django==3.1.*', '3.2.25', null],
    ['django==3.2.0', '3.2.25', 'django==3.2.25'],
    ['django === 3.2.0', '3.2.25', 'django === 3.2.25'],
    ['foo>=1.0,<2', '1.2', 'foo>=1.2,<2'],
    ['foo >= 1.0, < 2', '1.2', 'foo >= 1.2, < 2'],
    ['foo<2', '1.2', 'foo<2,>=1.2'],
    ['foo>=1.0,<1.2', '1.2', null],
    ['foo<=1.1', '1.2', null],
    ['foo<=1.2', '1.2', 'foo<=1.2,>=1.2'],
    ['foo!=1.1', '1.2', 'foo!=1.1,>=1.2'],
    ['foo!=1.2', '1.2', null],
    ['foo!=1.*', '1.2', null],
    ['foo>1.0,>=0.9,<2', '1.2', 'foo>=1.2,<2'],
    ['foo<2,>=0.9,>1.0', '1.2', 'foo<2,>=1.2'],
    ['foo>=1.0,==1.0', '1.2', 'foo>=1.0,==1.2'],
    ['foo>=4.0', '1.2', null], // already above the fix: nothing to change
    ['foo==1.2', '1.2', null],
    ['foo', '1.2', 'foo>=1.2'],
    ['foo  # pinned by the lock file', '1.2', 'foo>=1.2  # pinned by the lock file'],
    ['foo==1.0  # see the --hash docs', '1.2', 'foo==1.2  # see the --hash docs'],
    ['foo[bar,baz]>=1.0 ; python_version >= "3.8"', '1.2', 'foo[bar,baz]>=1.2 ; python_version >= "3.8"'],
    ['foo[bar];python_version<"3.12"', '1.2', 'foo[bar]>=1.2;python_version<"3.12"'],
    ['foo [bar] ~=1.0 ; sys_platform == "win32"  # windows only', '1.2', 'foo [bar] ~=1.0,>=1.2 ; sys_platform == "win32"  # windows only'],
    ['foo (>=1.0,<2)', '1.2', 'foo (>=1.2,<2)'],
    ['foo \\\n    >=1.0,<2 \\\n    ; python_version >= "3.8"', '1.2', 'foo \\\n    >=1.2,<2 \\\n    ; python_version >= "3.8"'],
    ['foo ~= 1.0 \\\r\n    ; os_name == "nt"  # windows', '1.2', 'foo ~= 1.0, >= 1.2 \\\r\n    ; os_name == "nt"  # windows'],
    ['foo>=1.0,\\\n    <2', '1.2', 'foo>=1.2,\\\n    <2'],
    ['foo==1.0 \\\n  # a comment line ends it', '1.2', 'foo==1.2 \\\n  # a comment line ends it'],
    [`foo==1.0 --hash=${HASH}`, '1.2', null],
    [`foo==1.0 \\\n    --hash=${HASH} \\\n    --hash=${HASH}`, '1.2', null],
    [`foo~=1.0 \\\n    --hash ${HASH}`, '1.2', null],
    ['foo==1.0 --config-settings key=value', '1.2', 'foo==1.2 --config-settings key=value'],
    ['foo @ https://example.invalid/foo-1.0.tar.gz', '1.2', null],
    ['foo==1.0', '1.2; rm -rf /', null], // a fixed version that is not a version is never written
    ['foo==1.0', '', null],
    ['foo>=1.0||<2', '1.2', null],
  ];
  for (const [before, fixed, want] of REWRITES) {
    const got = osv.upgradeRequirement(before, fixed);
    ok(got === want, `rewrite ${S(before)} for ${fixed} -> ${S(want)}${got === want ? '' : ` (got ${S(got)})`}`);
  }

  // The text the editor holds must still be the requirement that was checked.
  const SOURCES = [
    [{ kind: 'requirements', text: 'foo==1.0  # c', raw: 'foo==1.0', fixed: '1.2' }, 'foo==1.2  # c'],
    [{ kind: 'requirements', text: 'foo \\\n  ~=1.0  # c', raw: 'foo    ~=1.0', fixed: '1.2' }, 'foo \\\n  ~=1.0,>=1.2  # c'],
    [{ kind: 'requirements', text: `foo==1.0 \\\n  --hash=${HASH}`, raw: 'foo==1.0', fixed: '1.2' }, null],
    [{ kind: 'requirements', text: 'foo==1.1', raw: 'foo==1.0', fixed: '1.2' }, null],
    [{ kind: 'pyproject', text: 'foo~=1.0', raw: 'foo~=1.0', fixed: '1.2' }, 'foo~=1.0,>=1.2'],
    [{ kind: 'pipfile', text: 'foo==1.0', raw: 'foo==1.0', fixed: '1.2' }, null],
    [{ kind: 'requirements', text: 42, raw: 'foo', fixed: '1.2' }, null],
  ];
  for (const [p, want] of SOURCES) {
    const got = osv.upgradeSource(p);
    ok(got === want, `upgradeSource ${p.kind} ${S(p.text)} -> ${S(want)}${got === want ? '' : ` (got ${S(got)})`}`);
  }
  // What the IDE part below expects: the requirement block as the editor holds it (from its line to the end of its
  // continuation lines) and the raw text the dependency check reports.
  for (const [name, c, want] of [['compatible', E2E_COMPATIBLE, E2E_COMPATIBLE.fixedFile], ['excluded', E2E_EXCLUDED, null], ['hashed', E2E_HASHED, null]]) {
    const lines = c.file.split('\n');
    const req = deps.parseRequirementsTxt(c.file).reqs[0];
    let last = req.line;
    while (/\\\s*$/.test(lines[last - 1])) last++;
    const block = lines.slice(req.line - 1, last).join('\n');
    const got = osv.upgradeSource({ kind: 'requirements', text: block, raw: req.raw, fixed: '1.1' });
    const whole = got === null ? null : [...lines.slice(0, req.line - 1), got, ...lines.slice(last)].join('\n');
    ok(req.raw === c.raw && whole === want, `IDE case ${name}: raw ${S(req.raw)}, quick fix -> ${S(want)}${whole === want ? '' : ` (got ${S(whole)})`}`);
  }

  // Advisory data out of a damaged cache never throws.
  let threw = null;
  try {
    const junk = [{ id: 'X', affected: 'junk', aliases: 'x', references: {}, severity: 5 }, { id: 'Y', affected: [null, { package: { ecosystem: 'PyPI', name: 'foo' }, ranges: 'r', versions: 3 }] }];
    junk.forEach((v) => osv.summarize(v, 'foo'));
    osv.firstFixed(junk, 'foo', '1.0');
    osv.isAffected(junk[1], 'foo', '1.0');
  } catch (err) { threw = err; }
  ok(!threw, `summarize/firstFixed/isAffected accept advisories with fields of the wrong type${threw ? ` (${threw.message})` : ''}`);

  // ---------- the cache file ----------
  const aux = mkdtempSync(path.join(tmpdir(), 'pyide-vulns-unit-'));
  const now = Date.now();
  const advisory = { id: 'GHSA-unit-0001', summary: 'unit', affected: [{ package: { ecosystem: 'PyPI', name: 'okpkg' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.1' }] }] }] };
  const damaged = {
    queries: {
      'nullpkg@1': null, 'noat@1': { ids: ['GHSA-unit-0001'] }, 'noids@1': { at: now }, 'strat@1': { at: 'yesterday', ids: [] },
      'numids@1': { at: now, ids: [1] }, 'okpkg@1': { at: now, ids: ['GHSA-unit-0001'] },
    },
    vulns: { 'GHSA-unit-0001': { at: now, data: advisory }, NULLV: null, NODATA: { at: now }, STRDATA: { at: now, data: 'x' } },
  };
  const damagedText = JSON.stringify(damaged).replace('"queries":{', `"queries":{"__proto__":{"at":${now},"ids":["polluted"]},`);
  const fileIn = (name, text) => { const f = path.join(aux, name); writeFileSync(f, text); return f; };
  const loaded = vulnerabilities.loadCache(fileIn('damaged.json', damagedText));
  ok(S(Object.keys(loaded.queries).sort()) === S(['__proto__', 'okpkg@1']) && S(Object.keys(loaded.vulns)) === S(['GHSA-unit-0001']),
    `a damaged cache keeps only well-formed entries (${S(Object.keys(loaded.queries))} ${S(Object.keys(loaded.vulns))})`);
  ok(({}).ids === undefined && Object.getPrototypeOf(loaded.queries) === null, 'a "__proto__" key in the file is only a key');
  for (const [name, text] of [['notjson', '{"queries": {"a@1": {"at": 1, "ids'], ['null', 'null'], ['array', '[]'], ['wrongtypes', '{"queries": [], "vulns": "x"}'], ['empty', '']]) {
    const c = vulnerabilities.loadCache(fileIn(`${name}.json`, text));
    ok(!Object.keys(c.queries).length && !Object.keys(c.vulns).length, `a cache file that is ${name} loads as an empty cache`);
  }
  ok(!Object.keys(vulnerabilities.loadCache(path.join(aux, 'missing.json')).queries).length, 'a missing cache file loads as an empty cache');
  const saved = { queries: { 'old@1': { at: now - 8 * 86400000, ids: [] }, 'new@1': { at: now, ids: [] } }, vulns: {} };
  const saveFile = path.join(aux, 'nested', 'osv-cache.json');
  ok(vulnerabilities.saveCache(saveFile, saved, now) && S(Object.keys(JSON.parse(readFileSync(saveFile, 'utf8')).queries)) === S(['new@1']),
    'saving creates the folder, writes the file and drops entries a week past their time');
  ok(!readdirSync(path.dirname(saveFile)).some((n) => n.endsWith('.tmp')), 'saving leaves no temporary file behind');
  writeFileSync(path.join(aux, 'blocker'), 'a file where the cache folder should be');
  ok(vulnerabilities.saveCache(path.join(aux, 'blocker', 'osv-cache.json'), { queries: {}, vulns: {} }) === false, 'a cache that cannot be written is skipped quietly');

  // The IPC handlers over a damaged cache file, with a local fake OSV (never osv.dev).
  const userData = path.join(aux, 'userData');
  mkdirSync(path.join(userData, 'vulnerabilities'), { recursive: true });
  const cacheFile = path.join(userData, 'vulnerabilities', 'osv-cache.json');
  writeFileSync(cacheFile, damagedText);
  const handlers = {};
  vulnerabilities.register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, app: { getPath: () => userData } });
  const asked = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/querybatch') {
        const { queries } = JSON.parse(body);
        asked.push(...queries.map((q) => `${q.package.name}@${q.version}`));
        return res.end(S({ results: queries.map((q) => (q.package.name === 'nullpkg' ? { vulns: [{ id: 'GHSA-unit-0001' }] } : {})) }));
      }
      res.end(S(advisory));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const savedUrl = process.env.PYIDE_OSV_URL;
  process.env.PYIDE_OSV_URL = `http://127.0.0.1:${fake.address().port}`;
  try {
    const installed = ['nullpkg', 'noat', 'noids', 'strat', 'numids', 'okpkg'].map((name) => ({ name, version: '1' }));
    const files = [{ path: path.join(aux, 'requirements.txt'), kind: 'requirements', reqs: [{ name: 'okpkg', spec: '~=1.0', raw: 'okpkg~=1.0', line: 1, col: 1, endCol: 11, status: 'ok', installed: '1' }] }];
    const offline = await handlers['vulnerabilities:check'](null, { installed, files, network: false });
    ok(offline.packages.length === 1 && offline.packages[0].key === 'okpkg@1' && offline.packages[0].fixed === '1.1' && offline.unknown === 5,
      `a check over the damaged cache answers from its good entries (${S(offline.packages.map((p) => p.key))}, ${offline.unknown} unknown)`);
    ok(offline.requirements.length === 1 && !('replacement' in offline.requirements[0]) && offline.requirements[0].kind === 'requirements', 'the vulnerable requirement is reported with its file kind');
    const online = await handlers['vulnerabilities:check'](null, { installed, files, network: true });
    ok(!online.error && online.queried === 5 && S(asked.sort()) === S(['noat@1', 'noids@1', 'nullpkg@1', 'numids@1', 'strat@1']),
      `the next online check asks only what the damaged entries lost (${S(asked)}${online.error ? `, ${online.error}` : ''})`);
    ok(S(online.packages.map((p) => p.key).sort()) === S(['nullpkg@1', 'okpkg@1']), 'and finds the vulnerable ones');
    const written = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const wellFormed = Object.values(written.queries).every((e) => Number.isFinite(e?.at) && Array.isArray(e.ids)) && Object.values(written.vulns).every((e) => Number.isFinite(e?.at) && e.data && typeof e.data === 'object');
    ok(wellFormed && !('NULLV' in written.vulns) && !readdirSync(path.dirname(cacheFile)).some((n) => n.endsWith('.tmp')), 'the cache written back is well formed, with no temporary file left');
    const again = await handlers['vulnerabilities:check'](null, { installed, files, network: true });
    ok(!again.error && again.queried === 0, 'a third check within 24 h asks nothing');
    ok(await handlers['vulnerabilities:upgrade'](null, { kind: 'requirements', text: 'okpkg~=1.0  # ok', raw: 'okpkg~=1.0', fixed: '1.1' }) === 'okpkg~=1.0,>=1.1  # ok', 'vulnerabilities:upgrade rewrites the editor text');
    ok(await handlers['vulnerabilities:upgrade'](null, null) === null && await handlers['vulnerabilities:upgrade'](null, { kind: 'requirements', text: 'okpkg~=1.0.0', raw: 'okpkg~=1.0.0', fixed: '1.1' }) === null,
      'vulnerabilities:upgrade answers null for bad input and for a clause that excludes the fix');
    ok(await handlers['vulnerabilities:clearCache']() === true && S(JSON.parse(readFileSync(cacheFile, 'utf8'))) === S({ queries: {}, vulns: {} }), 'Clear Cache empties the file');
  } catch (err) {
    ok(false, `the handlers over a damaged cache threw: ${err.stack}`);
  } finally {
    if (savedUrl === undefined) delete process.env.PYIDE_OSV_URL; else process.env.PYIDE_OSV_URL = savedUrl;
    await new Promise((r) => fake.close(r));
  }

  console.log(`${unit.filter(Boolean).length}/${unit.length} passed (unit)`);
  if (unit.some((x) => !x)) process.exit(1);
  if (process.argv.includes('--unit')) process.exit(0);
}
const OSV_PORT = 9228;
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-vulns-aux-'));
const wheels = path.join(scratch, 'wheels');
const WHEELS = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for name, ver in (('pyide_vuln_demo', '1.0'), ('pyide_vuln_demo', '1.1')):
    info = f'{name}-{ver}.dist-info'
    files = {f'{name}/__init__.py': f'__version__ = "{ver}"\\n',
             f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: {name.replace("_", "-")}\\nVersion: {ver}\\n',
             f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = []
    with zipfile.ZipFile(os.path.join(sys.argv[1], f'{name}-{ver}-py3-none-any.whl'), 'w') as z:
        for p, c in files.items():
            b = c.encode()
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            z.writestr(p, b)
            record.append(f'{p},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`;
execFileSync('py', ['-3', '-I', '-c', WHEELS, wheels]);

const project = path.join(scratch, 'project');
cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vulnerabilities'), project, { recursive: true });
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);
const venvPython = path.join(project, '.venv', 'Scripts', 'python.exe');
const pipInstall = (spec) => execFileSync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', wheels, spec], { stdio: 'ignore' });
pipInstall('pyide-vuln-demo==1.0');

// ---------- the fake OSV database ----------
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
const ADVISORIES = {
  'GHSA-pyid-e000-0001': {
    id: 'GHSA-pyid-e000-0001', aliases: ['CVE-2099-0001'], summary: 'Remote code execution in pyide-vuln-demo loaders',
    database_specific: { severity: 'HIGH' },
    affected: [{ package: { ecosystem: 'PyPI', name: 'pyide-vuln-demo' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.1' }] }] }],
    references: [{ type: 'ADVISORY', url: 'https://example.invalid/GHSA-pyid-e000-0001' }],
  },
  'PYSEC-2099-7': {
    id: 'PYSEC-2099-7', details: 'Path traversal when extracting archives.\nMore text.',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }],
    affected: [{ package: { ecosystem: 'PyPI', name: 'pyide_vuln_demo' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0.5' }, { fixed: '1.1' }] }] }],
  },
};
const stats = { batches: 0, asked: [], details: 0 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/v1/querybatch') {
      stats.batches++;
      const { queries } = JSON.parse(body);
      stats.asked.push(...queries.map((q) => `${norm(q.package.name)}@${q.version}`));
      return send(200, { results: queries.map((q) => (q.package.ecosystem === 'PyPI' && norm(q.package.name) === 'pyide-vuln-demo' && q.version === '1.0'
        ? { vulns: Object.keys(ADVISORIES).map((id) => ({ id, modified: '2099-01-01T00:00:00Z' })) } : {})) });
    }
    const m = /^\/v1\/vulns\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && m && ADVISORIES[decodeURIComponent(m[1])]) { stats.details++; return send(200, ADVISORIES[decodeURIComponent(m[1])]); }
    send(404, { code: 5, message: 'not found' });
  });
});
const sockets = new Set();
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const startServer = () => new Promise((r) => server.listen(OSV_PORT, '127.0.0.1', r));
const stopServer = () => new Promise((r) => { server.close(r); for (const s of sockets) s.destroy(); });
await startServer();

const env = { PYIDE_OSV_URL: `http://127.0.0.1:${OSV_PORT}`, PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels };
const t = await launch({ fixture: 'vulnerabilities', port: 9220, projectDir: project, env });
const { js, until, press, check, shot, click, sleep } = t;
const markers = () => js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).map(m => ({ line: m.startLineNumber, msg: m.message, sev: m.severity }))`);
const demoRow = `document.querySelector('#pkgList .pkg-row[data-name="pyide-vuln-demo"]')`;
const settle = () => sleep(2500); // longer than the plugin's debounce after a listing or a dependency check

async function quickFix(line, column, title) {
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
  await press('Alt+Enter');
  await until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, 'quick fix menu');
  const titles = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
  if (!titles.some((x) => x.includes(title))) { await press('Escape'); return titles; }
  for (let i = 0; i < 8 && !(await js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes(${S(title)})`)); i++) await press('ArrowDown');
  await press('Enter');
  return titles;
}

let userData = t.userData;
try {
  // ---------- the project venv is the interpreter ----------
  const isVenv = `ide.currentInterp()?.executable.toLowerCase() === ${S(venvPython.toLowerCase())}`;
  try { await until(isVenv, 'project venv selected', 20000); } catch {
    await until(`ide.interps.some(i => i.executable.toLowerCase() === ${S(venvPython.toLowerCase())})`, 'venv listed', 20000);
    await js(`(ide.setInterpreter(${S(venvPython)}), true)`);
    await until(isVenv, 'venv selected');
  }

  // ---------- requirements.txt: squiggle, hover, Problems ----------
  await openFile(t, 'requirements.txt');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).length === 1`, 'vulnerability marker', 60000);
  const [mk] = await markers();
  check(mk.line === 2 && mk.sev === 4, 'the pinned vulnerable requirement has a warning squiggle on its line');
  check(mk.msg.includes("'pyide-vuln-demo' 1.0 has 2 known vulnerabilities") && mk.msg.includes('GHSA-pyid-e000-0001 (CVE-2099-0001)') && mk.msg.includes('PYSEC-2099-7') && mk.msg.includes('Fixed in 1.1'),
    `the message names the advisories, the CVE alias and the fixed version (${S(mk.msg)})`);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 5 }), ide.editor.trigger('test', 'editor.action.showHover', null), true)`);
  await until(`[...document.querySelectorAll('.monaco-hover')].some(h => h.textContent.includes('GHSA-pyid-e000-0001'))`, 'hover');
  check(true, 'hovering the line shows the advisories');
  await press('Escape');
  check(await js(`ide.problems.all().some(p => p.source === 'vulnerabilities' && p.line === 2 && p.severity === 'warning' && p.path.toLowerCase().endsWith('requirements.txt'))`), 'a Problems entry is listed for the requirement');
  await js(`(ide.toolWindows.get('Problems').show(), true)`);
  check(await js(`[...document.querySelectorAll('#problemList .problem')].some(r => r.textContent.includes('Vulnerable dependency') && r.textContent.includes('vulnerabilities'))`), 'the Problems window shows it with source "vulnerabilities"');

  // ---------- Python Packages window: icon and details ----------
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await until(`${demoRow}?.dataset.vulnerable === '2'`, 'vulnerable row', 60000);
  check(await js(`!!${demoRow}.querySelector('.pkg-vuln-icon') && !document.querySelector('#pkgList .pkg-row[data-name="pip"] .pkg-vuln-icon')`), 'the vulnerable package has a ⚠ icon, others do not');
  await click('#pkgList .pkg-row[data-name="pyide-vuln-demo"]');
  await until(`!!document.querySelector('#pkgVulns')`, 'details');
  const details = await js(`document.querySelector('#pkgVulns').textContent`);
  check(['2 known vulnerabilities', 'GHSA-pyid-e000-0001', 'CVE-2099-0001', 'HIGH', 'Remote code execution', 'PYSEC-2099-7', 'Path traversal when extracting archives.', 'CVSS_V3', 'Fixed in 1.1'].every((x) => details.includes(x)),
    `the details list each advisory: id, alias, severity, summary, fixed version (${details.slice(0, 300)})`);
  check(await js(`document.querySelector('#pkgVulnUpgrade')?.textContent === 'Upgrade to 1.1'`), 'the details offer "Upgrade to 1.1"');
  check(await js(`document.querySelector('#pkgVulns .pkg-vuln[data-id="GHSA-pyid-e000-0001"] .pkg-vuln-id').title === 'https://example.invalid/GHSA-pyid-e000-0001'`), 'the advisory links to its ADVISORY reference');
  await shot('vuln-details.png');

  // ---------- the cache: every package@version once ----------
  await settle();
  const dupes = stats.asked.filter((k, i) => stats.asked.indexOf(k) !== i);
  check(stats.asked.includes('pyide-vuln-demo@1.0') && stats.asked.includes(`pip@${await js(`ide.packages.list().find(p => p.name === 'pip').version`)}`) && !dupes.length,
    `each package@version was asked once (${stats.batches} batches: ${stats.asked.join(', ')})`);
  check(stats.details === 2, `each advisory was fetched once (${stats.details})`);
  const before = { ...stats, asked: stats.asked.length };
  await js(`(ide.packages.toolWindow.actionList[0].run(), true)`); // the window's Refresh
  await js('ide.dependencies.check({ fresh: true }).then(() => true)');
  await settle();
  check(stats.batches === before.batches && stats.details === before.details, `a new listing and dependency check within 24 h send nothing (${stats.batches - before.batches} batches)`);
  check(existsSync(path.join(t.userData, 'vulnerabilities', 'osv-cache.json')), 'the answers are cached in userData');

  // ---------- quick fix: Upgrade to 1.1 edits the pin ----------
  await openFile(t, 'requirements.txt');
  const titles = await quickFix(2, 5, 'Upgrade to 1.1');
  check(titles.some((x) => x.includes('Upgrade to 1.1')), `Alt+Enter on the line offers "Upgrade to 1.1" (${titles.join(' | ')})`);
  await until(`ide.editor.getModel().getLineContent(2) === 'pyide-vuln-demo==1.1'`, 'requirement edited');
  check(true, 'the quick fix rewrites the requirement to pyide-vuln-demo==1.1');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).length === 0`, 'squiggle gone', 30000);
  check(stats.asked.filter((k) => k === 'pyide-vuln-demo@1.1').length === 1, 'the new pin is checked (once) and its squiggle is gone');
  await js(`ide.saveAll().then(() => true)`);

  // ---------- the quick fix keeps what the line says; none for a clause that excludes the fix, or for --hash ----------
  const reqFile = path.join(project, 'requirements.txt');
  // Writes requirements.txt, reloads it and waits for a check of exactly that requirement.
  async function showRequirements(text, raw) {
    await js(`ide.saveAll().then(() => true)`);
    writeFileSync(reqFile, text);
    await openFile(t, 'requirements.txt');
    await js(`ide.reloadFromDisk().then(() => true)`);
    await until(`ide.editor.getModel().getValue() === ${S(text)}`, 'requirements.txt reloaded');
    await js('ide.dependencies.check({ fresh: true }).then(() => true)');
    await until(`ide.vulnerabilities.state().requirements.some(r => r.raw === ${S(raw)}) && ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).length === 1`, `checked: ${raw}`, 30000);
  }
  // The titles Alt+Enter offers on a line (none: Monaco says there are no actions).
  async function fixTitles(line, column) {
    await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
    await press('Alt+Enter');
    await sleep(1500);
    const list = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
    await press('Escape');
    return list;
  }
  await showRequirements(E2E_COMPATIBLE.file, E2E_COMPATIBLE.raw);
  const compatTitles = await quickFix(2, 5, 'Upgrade to 1.1');
  check(compatTitles.some((x) => x.includes('Upgrade to 1.1')), `a ~= requirement continued over two lines offers "Upgrade to 1.1" (${compatTitles.join(' | ')})`);
  await until(`ide.editor.getModel().getValue() === ${S(E2E_COMPATIBLE.fixedFile)}`, 'compatible requirement edited');
  check(true, 'the quick fix keeps ~=, the extras, the marker, the continuation and the comment, and adds >= 1.1');
  await showRequirements(E2E_EXCLUDED.file, E2E_EXCLUDED.raw);
  const excludedTitles = await fixTitles(1, 5);
  check(!excludedTitles.some((x) => x.includes('Upgrade to')), `~=1.0.0 (which excludes 1.1) keeps its warning but gets no "Upgrade to" (${excludedTitles.join(' | ')})`);
  await showRequirements(E2E_HASHED.file, E2E_HASHED.raw);
  const hashedTitles = await fixTitles(1, 5);
  const hashedMarker = (await markers())[0];
  check(hashedMarker?.line === 1 && hashedMarker.msg.includes('GHSA-pyid-e000-0001') && !hashedTitles.some((x) => x.includes('Upgrade to')),
    `a pin with --hash options shows the advisory but offers no rewrite (${hashedTitles.join(' | ')})`);
  check(await js(`ide.editor.getModel().getValue() === ${S(E2E_HASHED.file)}`), 'the hashed requirement is left as it was');
  // Back to the pin the first quick fix wrote.
  writeFileSync(reqFile, '# Packages with known vulnerabilities (the test serves a fake OSV database)\npyide-vuln-demo==1.1\n');
  await js(`ide.reloadFromDisk().then(() => true)`);
  await js('ide.dependencies.check({ fresh: true }).then(() => true)');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).length === 0`, 'pin restored', 30000);

  // ---------- Upgrade from the Packages window ----------
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await until(`${demoRow}?.dataset.vulnerable === '2'`, 'row listed again', 60000);
  await click('#pkgList .pkg-row[data-name="pyide-vuln-demo"]');
  await until(`!!document.querySelector('#pkgVulnUpgrade')`, 'upgrade button');
  const batchesBeforeUpgrade = stats.batches;
  await click('#pkgVulnUpgrade');
  await until(`document.querySelector('#pkgOut').textContent.includes('Installing pyide-vuln-demo==1.1')`, 'install started');
  await until(`${demoRow}?.querySelector('.pkg-ver')?.textContent === '1.1'`, 'upgraded', 120000);
  check(/Successfully installed pyide[-_]vuln[-_]demo-1\.1/i.test(await js(`document.querySelector('#pkgOut').textContent`)), 'Upgrade runs pip install pyide-vuln-demo==1.1 (the offline wheel)');
  await settle();
  check(!(await js(`${demoRow}.querySelector('.pkg-vuln-icon')`)) && !(await js(`document.querySelector('#pkgVulns')`)), 'after the upgrade the icon and the advisories are gone');
  check(stats.batches === batchesBeforeUpgrade, 'the upgraded version was already cached, so nothing was asked');

  // ---------- the server is down ----------
  await stopServer();
  const errorsBefore = t.consoleErrors.length;
  await click('[data-action="checkVulnerabilities"]');
  await until(`document.querySelector('#vulnStatus')?.dataset.kind === 'error'`, 'error note', 30000);
  check((await js(`document.querySelector('#vulnStatus').textContent`)).includes('Could not check for vulnerabilities:'), 'with the server down, Check for Vulnerabilities leaves a quiet note in the Packages window');
  check(t.consoleErrors.length === errorsBefore, 'and nothing throws');
  await shot('vuln-offline.png');
  await startServer();

  // ---------- the setting off: no requests ----------
  await js(`ide.api.invoke('vulnerabilities:clearCache')`);
  await js(`(ide.settings.set('packages.vulnerabilityCheck', false), true)`);
  await settle();
  const offAt = stats.batches;
  await js(`(ide.packages.toolWindow.actionList[0].run(), true)`);
  await js('ide.dependencies.check({ fresh: true }).then(() => true)');
  await settle();
  check(stats.batches === offAt, `with packages.vulnerabilityCheck off, a listing and a dependency check send nothing (${stats.batches - offAt})`);
  await js(`(ide.settings.set('packages.vulnerabilityCheck', true), true)`);
  await settle();
  check(stats.batches > offAt, 'turned on again, the next check asks OSV');

  // ---------- Safe Mode: only the manual check goes online ----------
  await js(`(ide.trusted = false, true)`);
  await js(`ide.api.invoke('vulnerabilities:clearCache')`);
  const safeAt = stats.batches;
  await js('ide.dependencies.check({ fresh: true }).then(() => true)');
  await until(`document.querySelector('#vulnStatus')?.dataset.kind === 'safe'`, 'safe mode note');
  check(stats.batches === safeAt, 'in an untrusted project nothing is sent automatically, and a note says so');
  await click('#vulnStatus button.link');
  await until(`document.querySelector('#vulnStatus')?.dataset.kind === 'done'`, 'manual check done');
  check(stats.batches === safeAt + 1, 'the note\'s Check for Vulnerabilities asks once');
  await js(`(ide.trusted = true, true)`);

  // ---------- back to 1.0 for the restart ----------
  pipInstall('pyide-vuln-demo==1.0');
  writeFileSync(path.join(project, 'requirements.txt'), '# Packages with known vulnerabilities (the test serves a fake OSV database)\npyide-vuln-demo==1.0\n');
  await js(`(ide.reloadFromDisk(), true)`);
  await js(`(ide.packages.toolWindow.actionList[0].run(), true)`);
  await until(`${demoRow}?.dataset.vulnerable === '2'`, 'vulnerable again', 60000);
  await until(`ide.problems.all().some(p => p.source === 'vulnerabilities')`, 'squiggle again', 30000);
  check(true, 'back on 1.0, the package and the requirement are flagged again');
  await settle();
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
const failedFirst = t.results.some((r) => !r.ok) || t.consoleErrors.length;
if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
console.log(`${t.results.filter((r) => r.ok).length}/${t.results.length} passed (English)`);
t.close();
await sleep(1500);

// ---------- Korean, after a restart with the same user data: answers come from the cache ----------
// The cache file also gets damaged entries (as a crash or a hand edit could leave them): the good ones still answer,
// and the next save drops the rest.
const cacheFile = path.join(userData, 'vulnerabilities', 'osv-cache.json');
let cacheDamaged = false;
try {
  const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
  Object.assign(c.queries, { 'junk-null@1': null, 'junk-noat@1': { ids: ['GHSA-pyid-e000-0001'] }, 'junk-noids@1': { at: Date.now() } });
  Object.assign(c.vulns, { 'JUNK-NULL': null, 'JUNK-NODATA': { at: Date.now() } });
  writeFileSync(cacheFile, JSON.stringify(c));
  cacheDamaged = true;
} catch (err) { console.log(`could not damage the cache file: ${err.message}`); }
const restartAt = stats.batches;
const k = await launch({ fixture: 'vulnerabilities', port: 9221, name: 'vulnerabilities-ko', projectDir: project, userData, lang: 'ko-KR', env });
try {
  await k.until(`ide.currentInterp()?.executable.toLowerCase() === ${S(venvPython.toLowerCase())}`, 'venv (ko)', 30000).catch(async () => {
    await k.js(`(ide.setInterpreter(${S(venvPython)}), true)`);
  });
  await openFile(k, 'requirements.txt');
  await k.until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' }).length === 1`, 'marker (ko)', 60000);
  const msg = await k.js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'vulnerabilities' })[0].message`);
  k.check(msg.includes('취약한 의존성') && msg.includes('1.1에서 수정됨'), `the squiggle message is Korean (${S(msg.split('\n')[0])})`);
  await k.js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await k.until(`${demoRow}?.dataset.vulnerable === '2'`, 'vulnerable row (ko)', 60000);
  await k.click('#pkgList .pkg-row[data-name="pyide-vuln-demo"]');
  await k.until(`!!document.querySelector('#pkgVulns')`, 'details (ko)');
  k.check(await k.js(`document.querySelector('#pkgVulnUpgrade').textContent === '1.1(으)로 업그레이드'`), 'the Upgrade button is Korean');
  let leaks = (await englishLeaks(k, '#pkgVulns, #vulnStatus')).map((l) => l.text);
  k.check(!leaks.length, `the advisory details are Korean apart from the advisory data (${leaks.join(' | ')})`);
  await k.sleep(2500);
  k.check(stats.batches === restartAt, `after a restart within 24 h nothing is asked again (${stats.batches - restartAt} batches)`);
  await k.click('[data-action="checkVulnerabilities"]');
  await k.until(`document.querySelector('#vulnStatus')?.dataset.kind === 'done'`, 'manual check (ko)');
  const after = JSON.parse(readFileSync(cacheFile, 'utf8'));
  const wellFormed = Object.values(after.queries).every((e) => Number.isFinite(e?.at) && Array.isArray(e.ids)) && Object.values(after.vulns).every((e) => Number.isFinite(e?.at) && e.data && typeof e.data === 'object');
  k.check(cacheDamaged && wellFormed && !Object.keys(after.queries).some((x) => x.startsWith('junk-')) && !Object.keys(after.vulns).some((x) => x.startsWith('JUNK-'))
    && !readdirSync(path.dirname(cacheFile)).some((n) => n.endsWith('.tmp')), 'a cache file with damaged entries kept working, and was written back without them (no temporary file left)');
  k.check(stats.batches === restartAt + 1, 'Check for Vulnerabilities asks again, ignoring the cache');
  k.check((await k.js(`document.querySelector('#vulnStatus').textContent`)).includes('취약한 패키지 1개를 찾았습니다'), 'the result note is Korean');
  await k.js(`(ide.openSettings('vulnerabilities'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'vulnerabilities'`, 'settings page (ko)');
  k.check(await k.js(`document.querySelector('[data-key="packages.vulnerabilityCheck"]').checked`), 'the setting defaults to on');
  leaks = (await englishLeaks(k, '.settings-dialog')).map((l) => l.text);
  k.check(!leaks.length, `the settings page is Korean (${leaks.join(' | ')})`);
  await k.shot('vuln-settings-ko.png');
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  const missing = (await missingTranslations(k)).filter((s) => /vulnerab|Upgrade to|Fixed in|fixed version|OSV|Safe Mode|Retry/i.test(s));
  k.check(!missing.length, `no missing translations (${missing.join(' | ')})`);
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure.png');
}
await stopServer();
if (failedFirst) { k.close(); process.exit(1); }
k.finish();
