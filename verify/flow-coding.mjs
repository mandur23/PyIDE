// End-to-end coding flow, as one person would do it in one continuous session: New Project wizard with a .venv, a
// small package and its tests written with file templates and live templates, completion with auto-import, navigation,
// refactorings, running, debugging, tests, coverage, profiling, scratches, the Python Console, installs, automation and
// the comfort features, then Close Project and Exit with no internal errors, stuck tasks or leftover processes.
// Offline: pytest, rope and coverage.py come from wheels repacked from interpreters on this machine (verify/out venvs
// or the default Python), a tiny wheel stands in for a PyPI package, and pip runs with PIP_NO_INDEX. Ports 9560-9563.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
const STOP = process.env.FLOW_STOP || ''; // development aid: stop after the named stage
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-flow-'));
const wheels = path.join(scratch, 'wheels');
const where = path.join(scratch, 'projects');
mkdirSync(where, { recursive: true });

// ---------------------------------------------------------------- offline wheels
// Repacks installed distributions into wheels (files from RECORD, a fresh RECORD), with their requirements.
const REPACK = String.raw`
import sys, os, re, zipfile, hashlib, base64, importlib.metadata as md
try:
    from pip._vendor.packaging.requirements import Requirement
except Exception:
    Requirement = None
out, names = sys.argv[1], sys.argv[2:]
os.makedirs(out, exist_ok=True)
seen, packed, done = set(), set(), []
def norm(n): return re.sub(r'[-_.]+', '-', n).lower()
def repack(d):
    info = None
    files = []
    for f in d.files or []:
        s = str(f).replace('\\', '/')
        if s.startswith('..') or '__pycache__' in s or s.endswith('.pyc'): continue
        if s.endswith('.dist-info/RECORD') or s.endswith(('/INSTALLER', '/REQUESTED', '/direct_url.json')): continue
        if '.dist-info/' in s: info = s.split('/')[0]
        files.append(s)
    if not info: return
    wheel = d.read_text('WHEEL') or ''
    tags = [l.split(':', 1)[1].strip().split('-') for l in wheel.splitlines() if l.startswith('Tag:')] or [['py3', 'none', 'any']]
    tag = '-'.join('.'.join(dict.fromkeys(t[i] for t in tags)) for i in range(3))  # py2.py3-none-any
    fn = f"{re.sub(r'[-_.]+', '_', d.metadata['Name'])}-{d.version}-{tag}.whl"
    record = []
    with zipfile.ZipFile(os.path.join(out, fn), 'w', zipfile.ZIP_DEFLATED) as z:
        for s in files:
            p = d.locate_file(s)
            if not os.path.isfile(p): continue
            b = open(p, 'rb').read()
            z.writestr(s, b)
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            record.append(f'{s},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\n'.join(record) + '\n')
    done.append(fn)
# A distribution and what it needs, with the requirements of the extras asked for (rope needs pytoolconfig[global]).
def pack(name, extras=()):
    if (norm(name), extras) in seen: return
    seen.add((norm(name), extras))
    try: d = md.distribution(name)
    except md.PackageNotFoundError: return
    if norm(name) not in packed:
        packed.add(norm(name))
        repack(d)
    for r in d.requires or []:
        if Requirement:
            req = Requirement(r)
            if req.marker and not any(req.marker.evaluate({'extra': e}) for e in ('',) + extras): continue
            pack(req.name, tuple(sorted(req.extras)))
        elif ';' not in r:
            pack(re.split(r'[\s<>=!~;\[(]', r, 1)[0])
for n in names: pack(n)
print('\n'.join(done))
`;
// A stand-in for a PyPI package the code imports before it is installed.
const TINY = String.raw`
import zipfile, hashlib, base64, sys, os
dist, module, ver = 'flow_units', 'flow_units', '1.2.0'
info = f'{dist}-{ver}.dist-info'
files = {f'{module}/__init__.py': 'CM_PER_INCH = 2.54\n\ndef to_cm(inches):\n    return inches * CM_PER_INCH\n',
         f'{info}/METADATA': f'Metadata-Version: 2.1\nName: flow-units\nVersion: {ver}\n',
         f'{info}/WHEEL': 'Wheel-Version: 1.0\nGenerator: pyide-verify\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
record = []
with zipfile.ZipFile(os.path.join(sys.argv[1], f'{dist}-{ver}-py3-none-any.whl'), 'w') as z:
    for p, c in files.items():
        b = c.encode()
        record.append(f'{p},sha256={base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode()},{len(b)}')
        z.writestr(p, b)
    record.append(f'{info}/RECORD,,')
    z.writestr(f'{info}/RECORD', '\n'.join(record) + '\n')
`;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
function defaultPython() {
  for (const [cmd, args] of [['py', ['-3']], ['python', []]]) {
    try { return sh(cmd, [...args, '-c', 'import sys; print(sys.executable)']).trim(); } catch {}
  }
  throw new Error('no Python found');
}
const basePython = defaultPython();
const baseVersion = sh(basePython, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).trim();
// Every interpreter that may hold the tools, same minor version first (coverage.py has a compiled part).
const sources = [basePython, ...['refactor-venv', 'coverage-profile-venv', 'notebook-venv', 'dataview-venv'].map((v) => path.join(HERE, 'out', v, 'Scripts', 'python.exe'))]
  .filter((p) => existsSync(p));
mkdirSync(wheels, { recursive: true });
for (const py of sources) {
  try {
    if (sh(py, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']).trim() !== baseVersion) continue;
    sh(py, ['-I', '-c', REPACK, wheels, 'pytest', 'rope', 'coverage']);
  } catch (err) { console.log(`note: repacking from ${py} failed (${err.message.split('\n')[0]})`); }
}
sh(basePython, ['-I', '-c', TINY, wheels]);
const have = readdirSync(wheels);
const hasWheel = (name) => have.some((f) => f.toLowerCase().startsWith(`${name}-`));
console.log(`offline wheels: ${have.join(', ')}`);
for (const need of ['pytest', 'rope']) if (!hasWheel(need)) { console.log(`FAIL no ${need} wheel can be made offline (run verify/refactor.mjs once, and install pytest for ${basePython})`); process.exit(1); }
const HAVE_COVERAGE = hasWheel('coverage');
if (!HAVE_COVERAGE) console.log('note: coverage.py is not installed in any local interpreter; the coverage step is skipped');

// ---------------------------------------------------------------- helpers
const env = { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
const t = await launch({ fixture: 'core', port: 9560, name: 'flow-coding', env });
const { js, until, press, type, click, check, shot, cdp, sleep } = t;
let P = ''; // the new project
const file = (rel) => path.join(P, ...rel.split('/'));
const read = (rel) => readFileSync(file(rel), 'utf8').replace(/\r\n/g, '\n');
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const row = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === ${J(name)})`;
const menuRow = (label) => `[...document.querySelectorAll('.context-menu .menu-item')].find(r => r.querySelector('.menu-label')?.textContent === ${J(label)})`;
const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.revealPositionInCenter({ lineNumber: ${line}, column: ${col} }), true)`);
const findLine = (needle) => js(`ide.editor.getModel().getLinesContent().findIndex(l => l.includes(${J(needle)})) + 1`);
async function caretAt(needle, offset = 0) {
  const line = await findLine(needle);
  if (!line) throw new Error(`no line with ${needle} in ${await js('ide.activeTab()?.title')}`);
  const col = (await js(`ide.editor.getModel().getLineContent(${line}).indexOf(${J(needle)})`)) + 1 + offset;
  await caret(line, col);
  return { line, col };
}
// A paste, as a person pastes a block of code (one undoable edit at the caret).
const paste = (code) => js(`(ide.editor.focus(), ide.editor.trigger('keyboard', 'paste', { text: ${J(code)} }), true)`);
const setAll = (code) => js(`(() => { const e = ide.editor; e.focus(); e.executeEdits('flow', [{ range: e.getModel().getFullModelRange(), text: ${J(code)} }]); e.pushUndoStop(); return true; })()`);
async function treeMenu(name, labels) {
  await until(`!!${row(name)}`, `tree row ${name}`);
  await js(`(() => { const n = ${row(name)}; n.scrollIntoView(); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  for (const label of labels) {
    await until(`!!${menuRow(label)}`, `menu item ${label}`);
    await js(`(${menuRow(label)}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true)`);
    await sleep(80);
  }
}
async function answerPrompt(value) {
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'name prompt');
  await js(`(document.querySelector('#popupIn').value = '', true)`);
  await type(value);
  await press('Enter');
}
const internalErrors = () => js(`ide.api.invoke('diagnostics:errors')`);
const menuItems = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`);
async function clickMenu(prefix) {
  const found = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes(${J(prefix)})); n?.classList.add('pick-menu'); return !!n; })()`);
  if (!found) throw new Error(`menu item ${prefix} not found in ${J(await menuItems())}`);
  await click('.context-menu .menu-item.pick-menu');
}
// Clicks the run icon in the gutter on a line, as a user does.
async function clickGutter(line) {
  await js(`ide.editor.revealLineInCenter(${line})`);
  const find = `(() => {
    const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(${line}) - ed.getScrollTop();
    const host = ed.getDomNode().getBoundingClientRect();
    const n = [...ed.getDomNode().querySelectorAll('.run-gutter-icon')].find(i => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
  await until(find, `gutter run icon on line ${line}`, 15000);
  const box = await js(find);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}
// A click in the breakpoint lane (glyph margin) of a line.
async function glyph(line, button = 'left') {
  const p = await js(`(() => { const e = ide.editor; e.revealLineInCenterIfOutsideViewport(${line}); e.render(true); const li = e.getLayoutInfo();
    const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
    return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
  await sleep(150);
}
const runText = (title) => js(`(ide.run.sessions().find(s => s.title === ${J(title)})?.con?.out?.textContent || '')`);
const runFinished = (title, ms = 60000) => until(`(ide.run.sessions().find(s => s.title === ${J(title)})?.con?.out?.textContent || '').includes('Process finished with exit code')`, `${title} finished`, ms);
const stoppedAt = (file, line, ms = 30000) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx];
  return f && f.path?.toLowerCase().endsWith(${J(file.toLowerCase())}) && f.line === ${line}; })()`, `suspended at ${file}:${line}`, ms);
const CTRL = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
const doubleCtrl = async () => { for (let i = 0; i < 2; i++) { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...CTRL, modifiers: 2 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...CTRL, modifiers: 0 }); } };
// Ctrl held while a letter is pressed, as a person types Ctrl+C.
const ctrlChord = async (l) => {
  const letter = { key: l.toLowerCase(), code: `Key${l.toUpperCase()}`, windowsVirtualKeyCode: l.toUpperCase().charCodeAt(0) };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...CTRL, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...letter, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...letter, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...CTRL, modifiers: 0 });
  await sleep(40);
};
const setInput = (sel, value) => js(`(() => { const n = document.querySelector(${J(sel)}); n.value = ${J(value)}; n.dispatchEvent(new Event(n.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
const clickSeen = async (sel) => { await js(`(document.querySelector(${J(sel)}).scrollIntoView({ block: 'center' }), true)`); await click(sel); };
// Every process below the IDE's main process, with its start time (a pid can be reused once it is gone).
const processTree = (rootPid) => JSON.parse(sh('powershell', ['-NoProfile', '-Command',
  `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate; $out = @(); $q = @(${rootPid});
   while ($q.Count) { $p = $q[0]; $q = @($q | Select-Object -Skip 1); foreach ($c in $all) { if ($c.ParentProcessId -eq $p) { $out += [pscustomobject]@{ pid = $c.ProcessId; name = $c.Name; cmd = [string]$c.CommandLine; created = [string]$c.CreationDate }; $q += $c.ProcessId } } }
   ConvertTo-Json -Compress -InputObject @($out)`]) || '[]');
const liveProcesses = (list) => {
  if (!list.length) return [];
  const now = JSON.parse(sh('powershell', ['-NoProfile', '-Command', `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; created = [string]$_.CreationDate } })`]));
  return list.filter((p) => now.some((n) => n.pid === p.pid && n.created === p.created));
};
const projectPythons = () => JSON.parse(sh('powershell', ['-NoProfile', '-Command',
  `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${P.toLowerCase().replace(/'/g, "''")}') } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine } })`]) || '[]');
const tasks = () => js(`ide.tasks.list().map(x => x.title)`);
// Enter as a keyboard sends it (a keyDown with text), so Monaco types a line break with auto-indent.
const enter = async () => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(60);
};
const suggestVisible = () => js(`!!document.querySelector('.suggest-widget.visible')`);
// The next live template variable: a completion popup that opened while typing is closed first, as in PyCharm.
// Completion answers arrive asynchronously, so wait a moment for one before deciding.
const closeSuggest = async () => {
  await until(`!!document.querySelector('.suggest-widget.visible')`, 'completion popup', 800).catch(() => {});
  if (await suggestVisible()) {
    await press('Escape');
    await until(`!document.querySelector('.suggest-widget.visible')`, 'completion popup closed', 2000);
  }
};
const nextStop = async () => { await closeSuggest(); await press('Tab'); await sleep(100); };
const toEnd = () => js(`(() => { const e = ide.editor, m = e.getModel(); const l = m.getLineCount(); e.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); e.focus(); return true; })()`);
const saveActive = async () => { await press('Ctrl+S'); await until(`!ide.isDirty(ide.activeTab())`, 'saved'); };
const stage = async (name, fn) => {
  console.log(`---- ${name}`);
  await fn();
  const errs = await internalErrors();
  check(!errs.length, `${name}: no internal errors${errs.length ? ` ${J(errs.map((e) => `${e.title || e.message}: ${(e.stack || '').split('\n').slice(0, 3).join(' | ')}`).slice(0, 3))}` : ''}`);
  const busy = await until(`!ide.tasks.list().length`, 'no background tasks', 30000).then(() => [], async () => tasks());
  check(!busy.length, `${name}: no background task left running${busy.length ? ` ${J(busy)}` : ''}`);
  check(!t.consoleErrors.length, `${name}: no renderer exceptions${t.consoleErrors.length ? ` ${J(t.consoleErrors.map((e) => e.split('\n')[0]))}` : ''}`);
  if (STOP === name) throw new Error(`stopped after ${name} (FLOW_STOP)`);
};

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), ide.settings.set('newProject.location', ${J(where)}), true)`);

  // ================================================================ 1. New Project wizard with a .venv
  await stage('wizard', async () => {
    await js(`ide.closeProject()`);
    await until(`!document.querySelector('#welcome').classList.contains('hidden')`, 'welcome screen');
    await click('#welcomeNew');
    await until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
    await js(`(() => { const i = document.querySelector('#npName'); i.value = 'geomflow'; i.dispatchEvent(new Event('input')); return true; })()`);
    check(await js(`document.querySelector('input[name="npMode"][value="venv"]').checked`), 'the wizard defaults to a new project venv');
    // The base interpreter the wheels were made for (coverage.py's wheel is for one Python version).
    await js(`(() => { const s = document.querySelector('#npBase'); const o = [...s.options].find(o => o.value.toLowerCase() === ${J(basePython.toLowerCase())}); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } return true; })()`);
    await shot('01-wizard.png');
    await click('#npCreate');
    P = path.join(where, 'geomflow');
    await until(`ide.root && ide.root.toLowerCase() === ${J(P.toLowerCase())}`, 'project opened', 180000);
    await until(`ide.activeTab()?.title === 'main.py'`, 'main.py opened');
    check(existsSync(file('.venv/Scripts/python.exe')), 'the wizard created .venv');
    await until(`ide.currentInterp()?.executable.toLowerCase() === ${J(file('.venv/Scripts/python.exe').toLowerCase())}`, 'the venv is the project interpreter', 30000);
    check(true, 'the new .venv is the project interpreter');
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  });

  // ================================================================ 2. a package with file templates and live templates
  await stage('templates', async () => {
    await treeMenu('geomflow', ['New', 'Python Package']);
    await answerPrompt('geo');
    await until(`ide.activeTab()?.path.toLowerCase().endsWith('geo\\\\__init__.py')`, 'geo/__init__.py opened');
    check(existsSync(file('geo/__init__.py')), 'New › Python Package made geo/__init__.py');
    await js(`ide.revealInTree(${J(file('geo/__init__.py'))})`);
    await treeMenu('geo', ['New', 'Python File']);
    await answerPrompt('shapes');
    await until(`ide.activeTab()?.title === 'shapes.py'`, 'shapes.py opened');
    check(existsSync(file('geo/shapes.py')), 'New › Python File made geo/shapes.py');
    // dataclass + Tab: the template adds its import and visits NAME, FIELD and TYPE.
    await caret(1, 1);
    await type('dataclass');
    await sleep(150);
    await press('Tab');
    await until(`ide.editor.getModel().getValue().includes('@dataclass')`, 'dataclass expanded');
    await type('Rect');
    await nextStop();
    await type('width');
    await nextStop();
    await type('float');
    await nextStop();
    let s = await text();
    check(s.startsWith('from dataclasses import dataclass\n') && s.includes('@dataclass\nclass Rect:\n    width: float'), `dataclass+Tab expands with its import and the typed tab stops (${J(s)})`);
    await closeSuggest();
    await toEnd();
    await enter();
    await type('height: float');
    await closeSuggest();
    await enter();
    await enter();
    // prop + Tab inside the class
    await type('prop');
    await sleep(150);
    await press('Tab');
    await type('area');
    await nextStop();
    s = await text();
    check(/class Rect:\n {4}width: float\n {4}height: float\n\n {4}@property\n {4}def area\(self\):\n {8}return self\._area/.test(s), `prop+Tab inside the class mirrors the name (${J(s)})`);
    // the body is changed by hand, the rest is pasted
    const ret = await caretAt('return self._area');
    await js(`(() => { const e = ide.editor; const l = ${ret.line}; e.executeEdits('flow', [{ range: new ide.monaco.Range(l, 1, l, e.getModel().getLineMaxColumn(l)), text: '        return self.width * self.height' }]); return true; })()`);
    await js(`(() => { const e = ide.editor, m = e.getModel(); e.setPosition({ lineNumber: 2, column: 1 }); return true; })()`);
    await paste('import math\n');
    await js(`(() => { const e = ide.editor, m = e.getModel(); const l = m.getLineCount(); e.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); return true; })()`);
    await paste('\n\n\ndef circle_area(radius):\n    return math.pi * radius ** 2\n\n\ndef total_area(shapes):\n    total = 0\n    for shape in shapes:\n        total += shape.area\n    return total\n');
    await saveActive();
    // a unit test from the Python Unit Test template, then a pytest test with pt + Tab
    await js(`ide.revealInTree(${J(file('main.py'))})`);
    await treeMenu('geomflow', ['New', 'Python Unit Test']);
    await answerPrompt('test_shapes');
    await until(`ide.activeTab()?.title === 'test_shapes.py'`, 'test_shapes.py opened');
    s = await text();
    check(s.startsWith('import unittest\n\n\nclass MyTestCase(unittest.TestCase):'), 'New › Python Unit Test fills the unit test template');
    await setAll('from geo.shapes import Rect, circle_area\n\n\n');
    await js(`(() => { const e = ide.editor, m = e.getModel(); e.setPosition({ lineNumber: m.getLineCount(), column: 1 }); return true; })()`);
    await type('pt');
    await sleep(150);
    await press('Tab');
    await type('rect_area');
    await nextStop();
    await type('assert Rect(2, 3).area == 6');
    await closeSuggest();
    await toEnd();
    await paste('\n\n\ndef test_circle_area():\n    assert round(circle_area(1), 2) == 3.14\n');
    s = await text();
    check(s.includes('def test_rect_area():\n    assert Rect(2, 3).area == 6'), `pt+Tab writes a pytest test (${J(s)})`);
    await saveActive();
    await shot('02-templates.png');
  });

  // ================================================================ 3. completion with auto-import, import quick fix
  await stage('completion', async () => {
    await openFile(t, 'main.py');
    await js(`(window.__pub = [], window.__t0 = Date.now(), ide.api.on('lsp:diagnostics', (p) => window.__pub.push([Date.now() - window.__t0, p.version, p.uri.split('/').pop(), p.diagnostics.map(d => d.message.slice(0, 25) + '@' + d.range.start.line).join('; ')])), true)`);
    await setAll('def main():\n    shapes = [Rect(2, 3), Rect(1, 1)]\n    print("total area:", )\n\n\nif __name__ == "__main__":\n    main()\n');
    await caretAt(', )', 2);
    await type('total_ar');
    await js(`(ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
    const item = `[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].find(r => r.querySelector('.label-name')?.textContent === 'total_area')`;
    await until(`!!${item}`, 'total_area offered by completion', 30000);
    for (let i = 0; i < 30 && !(await js(`!!${item}?.classList.contains('focused')`)); i++) await press('ArrowDown');
    await press('Enter');
    await type('(shapes)');
    await until(`ide.editor.getModel().getValue().includes('from geo.shapes import total_area')`, 'auto-import added', 10000);
    let s = await text();
    check(s.startsWith('from geo.shapes import total_area\n') && s.includes('print("total area:", total_area(shapes))'), `completing an unimported function adds its import (${J(s)})`);
    // Rect is unresolved: Alt+Enter right away, before Pyright has looked at the text with the new import line.
    await caretAt('Rect(2', 1);
    await sleep(400);
    await press('Alt+Enter');
    const fix = `[...document.querySelectorAll('.action-widget .monaco-list-row.action')].find(n => n.textContent.includes("Import 'Rect' from 'geo.shapes'"))`;
    await js('(window.__alt = Date.now() - window.__t0, true)');
    await until(`!!${fix}`, 'import quick fix', 30000).catch(async (e) => { console.log('ALT at', await js('window.__alt'), 'version', await js('ide.editor.getModel().getVersionId()'), 'rows', J(await js(`[...document.querySelectorAll('.action-widget .monaco-list-row')].map(n => n.textContent)`))); for (const x of await js('window.__pub')) console.log('PUB', J(x)); throw e; });
    const fixes = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
    check(new Set(fixes).size === fixes.length, `Alt+Enter lists each fix once although Rect is used twice on the line (${J(fixes)})`);
    await shot('03-import-fix.png');
    check(await js(`!!${fix}?.classList.contains('focused')`) && /Import 'Rect'/.test(fixes[0]), `the import leads the list, so Alt+Enter, Enter imports (${J(fixes)})`);
    for (let i = 0; i < 12 && !(await js(`!!${fix}?.classList.contains('focused')`)); i++) await press('ArrowDown');
    await press('Enter');
    await until(`/^from geo\\.shapes import .*Rect/m.test(ide.editor.getModel().getValue())`, 'Rect imported');
    s = await text();
    check(/^from geo\.shapes import (Rect, total_area|total_area, Rect)\n\n\ndef main/.test(s), `the quick fix adds Rect to the existing import of geo.shapes (${J(s.split('\n').slice(0, 3))})`);
    await saveActive();
    await until(`!ide.problems.all().some(p => p.path.toLowerCase() === ${J(file('main.py').toLowerCase())} && p.severity === 'error')`, 'no errors left in main.py', 30000);
    check(true, 'main.py has no errors once the imports are in');
  });

  // ================================================================ 4. navigation into closed files
  await stage('navigation', async () => {
    for (const rel of ['geo/shapes.py', 'test_shapes.py', 'geo/__init__.py']) await js(`(ide.closeTab(${J(file(rel))}), true)`);
    await openFile(t, 'main.py');
    await caretAt('total_area(shapes)', 2);
    await press('Ctrl+B');
    await until(`ide.activeTab()?.title === 'shapes.py'`, 'Ctrl+B opened shapes.py');
    const def = await js(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber)`);
    check(def.startsWith('def total_area('), `Ctrl+B goes to the definition in the closed file (${def})`);
    await js(`(ide.closeTab(${J(file('geo/shapes.py'))}), true)`);
    await openFile(t, 'main.py');
    // Peek Definition
    const shown = `n => n.getClientRects().length > 0 && n.getBoundingClientRect().height > 0`;
    await caretAt('Rect(2', 1);
    await js(`(ide.editor.trigger('t', 'editor.action.peekDefinition', null), true)`);
    await until(`[...document.querySelectorAll('.peekview-widget .view-lines')].filter(${shown}).some(n => n.textContent.replace(/\\u00a0/g, ' ').includes('class Rect'))`, 'peek shows class Rect', 15000);
    check(await js(`ide.activeTab()?.title === 'main.py' && !ide.findTab(${J(file('geo/shapes.py'))})`), 'Peek Definition shows class Rect from the closed file without opening it');
    await shot('04-peek.png');
    await press('Escape');
    // Ctrl+hover, then Ctrl+click
    const pos = await caretAt('total_area(shapes)', 3);
    const at = await js(`(() => { const ed = ide.editor, p = ed.getScrolledVisiblePosition({ lineNumber: ${pos.line}, column: ${pos.col} }), r = ed.getDomNode().getBoundingClientRect();
      return { x: Math.round(r.left + p.left + 2), y: Math.round(r.top + p.top + p.height / 2) }; })()`);
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    for (const dx of [-4, 0, 2]) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + dx, y: at.y, modifiers: 2 });
    await until(`!!document.querySelector('.goto-definition-link')`, 'Ctrl+hover link', 15000);
    check(true, 'Ctrl+hover underlines a name defined in a closed file');
    await sleep(300);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x + 2, y: at.y, modifiers: 2, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await until(`ide.activeTab()?.title === 'shapes.py' && ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).startsWith('def total_area')`, 'Ctrl+click navigation');
    check(true, 'Ctrl+click opens the definition');
    // Find Usages
    await caretAt('class Rect', 6);
    await press('Alt+F7');
    await until(`ide.toolWindows.get('FindUsages').isVisible() && /Rect/.test(document.querySelector('.lsp-find-head')?.textContent)`, 'usages of Rect', 30000);
    await until(`(() => { const f = [...document.querySelectorAll('#lspFindList .lsp-find-file .name')].map(n => n.textContent); return f.includes('main.py') && f.includes('test_shapes.py'); })()`, 'usages in main.py and test_shapes.py', 30000);
    const rows = await js(`[...document.querySelectorAll('#lspFindList .lsp-find-row')].map(r => r.textContent)`);
    check(rows.some((r) => r.includes('shapes = [Rect(2, 3), Rect(1, 1)]')) && rows.some((r) => r.includes('assert Rect(2, 3).area == 6')), `Find Usages lists the usages in other files (${J(rows)})`);
    await shot('04-find-usages.png');
    const crumbs = () => js(`[...ide.groups().find(g => g.editor === ide.editor).el.querySelectorAll('.nb-bar .nb-crumb[data-kind="path"] .nb-name')].map(n => n.textContent).join('/')`);
    const shownCrumbs = await until(`(() => { const g = ide.groups().find(g => g.editor === ide.editor); return [...g.el.querySelectorAll('.nb-bar .nb-crumb[data-kind="path"] .nb-name')].map(n => n.textContent).join('/') === 'geo/shapes.py'; })()`, 'breadcrumbs of shapes.py', 2000).then(() => true, () => false);
    check(shownCrumbs, `the breadcrumbs name the file that is shown (${await crumbs()})`);
    // Pyright slow to answer (busy with a large Find Usages): the path still changes at once.
    const slowCrumbs = await js(`(async () => {
      const real = ide.lsp.documentSymbols;
      ide.lsp.documentSymbols = (p) => new Promise((r) => setTimeout(() => r(real(p)), 1500));
      try {
        await ide.openFile(${J(file('test_shapes.py'))});
        await new Promise((r) => setTimeout(r, 400));
        const g = ide.groups().find(g => g.editor === ide.editor);
        return [...g.el.querySelectorAll('.nb-bar .nb-crumb[data-kind="path"] .nb-name')].map(n => n.textContent).join('/');
      } finally { ide.lsp.documentSymbols = real; }
    })()`);
    check(slowCrumbs === 'test_shapes.py', `while Pyright is busy the breadcrumbs already name the new file (${slowCrumbs})`);
    await press('Escape');
  });

  // ================================================================ 5. rename a symbol, then a module and a move from the tree
  await stage('rename', async () => {
    await openFile(t, 'geo/shapes.py');
    await caretAt('def total_area', 5);
    await press('Shift+F6');
    await until(`document.activeElement?.closest('.rename-box') && document.activeElement.value === 'total_area'`, 'inline rename box');
    await type('sum_areas');
    await press('Enter');
    await until(`ide.editor.getModel().getValue().includes('def sum_areas(')`, 'renamed in shapes.py');
    await until(`(async () => /sum_areas\\(shapes\\)/.test(await ide.api.read(${J(file('main.py'))})) || /sum_areas\\(shapes\\)/.test(ide.findTab(${J(file('main.py'))})?.model.getValue() || ''))()`, 'renamed in main.py');
    await js(`ide.saveAll()`);
    check(/^from geo\.shapes import (Rect, sum_areas|sum_areas, Rect)$/m.test(read('main.py')) && read('main.py').includes('sum_areas(shapes)'), 'Shift+F6 renames the function and its import and call in main.py');

    const selectRow = async (rel) => {
      await js(`ide.revealInTree(${J(file(rel))})`);
      await until(`document.querySelector('#tree .node.selected')?._entry?.path.toLowerCase() === ${J(file(rel).toLowerCase())}`, `tree row ${rel}`);
      await js(`(document.getElementById('tree').focus(), true)`);
    };
    // rope is not in the new venv: the rename offers to install it (offline wheel) and then goes on
    await selectRow('geo/shapes.py');
    await press('Shift+F6');
    await until(`!!document.querySelector('#rfRenameModuleDialog')`, 'rename module dialog', 30000);
    check(await js(`document.querySelector('#rfRenameModuleDialog .rf-message').textContent`) === "Rename module 'geo.shapes' to:", 'the module rename dialog names geo.shapes');
    await js(`(() => { const i = document.querySelector('#rfRenameModuleDialog .rf-name'); i.value = 'figures.py'; i.dispatchEvent(new Event('input')); return true; })()`);
    await press('Enter');
    const renamed = `(async () => await ide.api.exists(${J(file('geo/figures.py'))}))()`;
    await until(`!!document.querySelector('#rfInstallDialog') || ${renamed}`, 'rope offer or the rename', 60000);
    if (await js(`!!document.querySelector('#rfInstallDialog')`)) {
      await shot('05-install-rope.png');
      await js(`[...document.querySelectorAll('#rfInstallDialog .dialog-buttons button')].find(b => b.textContent === 'Install rope').click(), true`);
      await until(`!document.querySelector('#rfInstallDialog')`, 'rope installed', 180000);
      check(true, 'without rope in the venv the rename offers Install rope, which installs it offline');
    } else check(false, 'expected the rope install offer in a fresh venv');
    await until(renamed, 'geo/figures.py', 60000);
    await js(`ide.saveAll()`);
    await sleep(300);
    check(!existsSync(file('geo/shapes.py')) && /^from geo\.figures import/m.test(read('main.py')) && read('test_shapes.py').startsWith('from geo.figures import Rect, circle_area'),
      `renaming the module from the tree rewrites the imports (${J(read('main.py').split('\n')[0])}, ${J(read('test_shapes.py').split('\n')[0])})`);
    // a sub-package, then Cut / Paste the module into it
    await js(`ide.revealInTree(${J(file('geo/__init__.py'))})`);
    await treeMenu('geo', ['New', 'Python Package']);
    await answerPrompt('plane');
    await until(`(async () => await ide.api.exists(${J(file('geo/plane/__init__.py'))}))()`, 'geo/plane');
    await selectRow('geo/figures.py');
    await press('Ctrl+X');
    await selectRow('geo/plane');
    await press('Ctrl+V');
    await until(`!!document.querySelector('#rfMoveDialog')`, 'move dialog', 30000);
    await click('#rfMoveDialog [data-action="refactor"]');
    await until(`!document.querySelector('#rfMoveDialog')`, 'move dialog closed', 60000);
    await until(`(async () => await ide.api.exists(${J(file('geo/plane/figures.py'))}))()`, 'moved', 60000);
    await js(`ide.saveAll()`);
    await sleep(300);
    check(/^from geo\.plane\.figures import/m.test(read('main.py')) && read('test_shapes.py').startsWith('from geo.plane.figures import Rect, circle_area'),
      `moving the module rewrites the imports (${J(read('main.py').split('\n')[0])})`);
    const out = sh(file('.venv/Scripts/python.exe'), ['main.py'], { cwd: P }).trim();
    check(out === 'total area: 7', `the program still runs after the refactorings (${out})`);
  });

  // ================================================================ 6. Extract Method, Reformat Code, Optimize Imports
  await stage('extract-format', async () => {
    await openFile(t, 'main.py');
    const l = await findLine('shapes = [Rect(2, 3)');
    await js(`(ide.editor.focus(), ide.editor.setSelection(new ide.monaco.Selection(${l}, 1, ${l + 1}, 1)), true)`);
    await press('Ctrl+Alt+M');
    await until(`!!document.querySelector('#rfExtractMethodDialog')`, 'extract method dialog', 30000);
    await js(`(() => { const i = document.querySelector('#rfExtractMethodDialog .rf-name'); i.value = 'make_shapes'; i.dispatchEvent(new Event('input')); return true; })()`);
    await press('Enter');
    await until(`ide.editor.getModel().getValue().includes('def make_shapes(')`, 'method extracted', 30000);
    let s = await text();
    check(s.includes('    shapes = make_shapes()\n') && /def make_shapes\(\):\n {4}shapes = \[Rect\(2, 3\), Rect\(1, 1\)\]\n {4}return shapes\n/.test(s), `Extract Method moves the line into make_shapes() (${J(s)})`);
    // a messy function and unused imports, then Ctrl+Alt+L and Ctrl+Alt+O
    await toEnd();
    await paste('\n\ndef  messy( a,b ):\n  return a+b\n');
    await js(`(ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await paste('import sys\nimport os\n');
    await press('Ctrl+Alt+L');
    await until(`ide.editor.getModel().getValue().includes('def messy(a, b):\\n    return a + b')`, 'reformatted', 30000);
    check(true, 'Ctrl+Alt+L reformats the file with ruff');
    await press('Ctrl+Alt+O');
    await until(`!/^import (os|sys)$/m.test(ide.editor.getModel().getValue())`, 'imports optimized', 30000);
    s = await text();
    check(s.startsWith('from geo.plane.figures import'), `Ctrl+Alt+O removes the unused imports (${J(s.split('\n').slice(0, 3))})`);
    await saveActive();
    const out = sh(file('.venv/Scripts/python.exe'), ['main.py'], { cwd: P }).trim();
    check(out === 'total area: 7', `the program still prints the same (${out})`);
  });

  // ================================================================ 7. running: run widget, gutter, Run Anything
  await stage('run', async () => {
    await openFile(t, 'main.py');
    await click('.run-target');
    await clickMenu('Current File');
    await click('.run-btn');
    await until(`ide.run.activeSession()?.title === 'main'`, 'main run tab');
    await runFinished('main');
    let out = await runText('main');
    check(out.includes('total area: 7') && out.includes('exit code 0'), `the run widget runs the current file (${J(out.slice(-120))})`);
    const mainLine = await findLine('if __name__');
    await clickGutter(mainLine);
    const gm = await menuItems();
    check(gm.some((s) => s.includes("Run 'main'")) && gm.some((s) => s.includes("Debug 'main'")), `the gutter menu offers Run and Debug (${J(gm)})`);
    await clickMenu("Run 'main'");
    await until(`(ide.run.sessions().find(s => s.title === 'main')?.con?.out?.textContent || '').includes('exit code') && ide.run.activeSession()?.running === false`, 'gutter run finished', 60000);
    check((await runText('main')).includes('total area: 7'), 'the gutter run icon runs main.py');
    // Run Anything with Double Ctrl
    await js('(ide.editor.focus(), true)');
    await doubleCtrl();
    await until(`!!document.querySelector('#runAnything')`, 'Run Anything');
    await js(`(document.querySelector('#runAnythingInput').value = '', true)`);
    await type('python main.py');
    await sleep(200);
    await press('Enter');
    await until(`!document.querySelector('#runAnything')`, 'Run Anything closed');
    await runFinished('python main.py');
    out = await runText('python main.py');
    check(out.includes('total area: 7'), `Double Ctrl, "python main.py", Enter runs it in the Run window (${J(out.slice(-120))})`);
    await shot('07-run.png');
  });

  // ================================================================ 8. debugging: breakpoints, condition, step, evaluate, attach
  await stage('debug', async () => {
    await openFile(t, 'geo/plane/figures.py');
    const loopLine = await findLine('total += shape.area');
    await glyph(loopLine);
    await until(`window.__debugger.breakpoints().some(b => b.line === ${loopLine})`, 'breakpoint added');
    await glyph(loopLine, 'right');
    await until(`!!document.querySelector('#dbgBpCondition')`, 'condition popup');
    await js(`document.querySelector('#dbgBpCondition').focus()`);
    await type('shape.width == 1');
    await press('Enter');
    await until(`!document.querySelector('#dbgBpCondition') && window.__debugger.breakpoints().find(b => b.line === ${loopLine})?.condition === 'shape.width == 1'`, 'condition set');
    check(true, 'a breakpoint with a condition is set from the gutter');
    await openFile(t, 'main.py');
    await clickGutter(await findLine('if __name__'));
    await clickMenu("Debug 'main'");
    await stoppedAt('figures.py', loopLine, 60000);
    await until(`document.querySelector('#dbgVars').textContent.includes('total = {int} 6')`, 'variables', 15000);
    const vars = await js(`document.querySelector('#dbgVars').textContent`);
    check(vars.includes('total = {int} 6') && /shape = \{Rect\}/.test(vars), `the conditional breakpoint stops only for the 1x1 rectangle (${J(vars.slice(0, 160))})`);
    await shot('08-debug.png');
    await press('Alt+F8');
    await until(`!!document.querySelector('#dbgEvalInput')`, 'evaluate dialog');
    await js(`(document.querySelector('#dbgEvalInput').value = '', document.querySelector('#dbgEvalInput').focus())`);
    await type('total + shape.area');
    await press('Enter');
    await until(`/\\b7\\b/.test(document.querySelector('#dbgEvalResult')?.textContent || '')`, 'evaluate result');
    check(true, 'Alt+F8 evaluates an expression in the frame');
    await press('Escape');
    await js('(ide.editor.focus(), true)');
    await press('F8');
    await until(`(() => { const s = window.__debugger.state(); return s?.state === 'suspended' && s.frames[s.frameIdx].line !== ${loopLine}; })()`, 'stepped');
    check(true, 'F8 steps over');
    await press('F9');
    await until(`document.querySelector('#dbgOut')?.textContent.includes('exit code')`, 'debugged program finished', 30000);
    check((await js(`document.querySelector('#dbgOut').textContent`)).includes('total area: 7'), 'F9 resumes and the program finishes');
    // Attach to Process: a long-running script started outside the IDE
    writeFileSync(file('server.py'), 'import time\n\nfrom geo.plane.figures import Rect, sum_areas\n\n\ndef tick(n):\n    return sum_areas([Rect(n, 1)])\n\n\nif __name__ == "__main__":\n    n = 0\n    while True:\n        n += 1\n        tick(n)\n        time.sleep(0.2)\n');
    const server = spawn(file('.venv/Scripts/python.exe'), [file('server.py')], { cwd: P, stdio: 'ignore', windowsHide: true });
    try {
      await openFile(t, 'server.py');
      await caretAt('return sum_areas', 4);
      await press('Ctrl+F8');
      await press('Ctrl+Alt+F5');
      await until(`!!document.querySelector('#dbgAttachFilter')`, 'Attach to Process dialog');
      await until(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].some(r => r.title.toLowerCase().includes('server.py'))`, 'server.py listed', 30000);
      await type('server.py');
      await until(`!!document.querySelector('#dbgAttachList .dbg-attach-row.selected')?.title.toLowerCase().includes('server.py')`, 'server.py selected');
      await press('Enter');
      await stoppedAt('server.py', 7, 60000);
      check(true, 'Attach to Process stops at a breakpoint in a script started outside the IDE');
      await until(`/n = \\{int\\} \\d+/.test(document.querySelector('#dbgVars').textContent)`, 'n in variables');
      await js('(ide.editor.focus(), true)');
      await press('Ctrl+F2');
      await until(`!window.__debugger.state() || window.__debugger.state().state === 'idle' || !window.__debugger.state().state`, 'detached', 20000).catch(() => {});
      await sleep(500);
      let alive = true;
      try { process.kill(server.pid, 0); } catch { alive = false; }
      check(alive, 'Ctrl+F2 detaches and the process keeps running');
      await caretAt('return sum_areas', 4);
      await press('Ctrl+F8');
    } finally {
      try { execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
  });

  // ================================================================ 9. tests: pytest from requirements.txt, run, auto-test on save
  await stage('tests', async () => {
    writeFileSync(file('requirements.txt'), 'pytest\n');
    await js(`ide.revealInTree(${J(file('requirements.txt'))})`);
    await openFile(t, 'requirements.txt');
    const banner = `document.querySelector('.deps-banner:not(.hidden) [data-action="install"]')`;
    await until(`!!${banner}`, 'requirements banner', 60000);
    check(true, 'requirements.txt with pytest shows the "not installed" banner');
    await js(`${banner}.click()`);
    await until(`/Successfully installed .*pytest/i.test(document.querySelector('#pkgOut')?.textContent || '')`, 'pytest installed', 240000);
    check(true, 'Install runs pip install -r requirements.txt offline');
    await until(`!document.querySelector('.deps-banner:not(.hidden)')`, 'banner gone', 30000);
    await openFile(t, 'test_shapes.py');
    await caret(1, 1);
    await press('Ctrl+Shift+F10');
    const waitTests = (label) => until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running' && /Tests/.test(s.textContent); })()`, label, 90000);
    const status = () => js(`document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || ''`);
    await waitTests('tests ran');
    check((await status()).includes('Tests passed: 2 of 2 tests'), `Ctrl+Shift+F10 runs the test file (${await status()})`);
    await click('#bottomActions button[data-action="autoTest"]');
    await until(`document.querySelector('#bottomActions button[data-action="autoTest"]').getAttribute('aria-pressed') === 'true'`, 'auto-test on');
    // break the property, save: the tests run by themselves and fail
    await openFile(t, 'geo/plane/figures.py');
    await caretAt('self.width * self.height', 11);
    await js(`(() => { const e = ide.editor, p = e.getPosition(); e.executeEdits('flow', [{ range: new ide.monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column + 1), text: '+' }]); return true; })()`);
    await saveActive();
    await until(`/Tests failed: 1, passed: 1/.test(document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || '')`, 'auto-test: failure', 90000);
    check(true, 'with auto-test on, saving a broken module re-runs the tests (1 failed)');
    check(await js(`ide.activeTab()?.title === 'figures.py' && ide.editor.hasTextFocus()`), 'the editor keeps the keyboard during the auto-test run');
    await js(`(ide.editor.focus(), ide.editor.trigger('flow', 'undo', null), true)`);
    await saveActive();
    await until(`/Tests passed: 2 of 2/.test(document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || '')`, 'auto-test: passed', 90000);
    check(true, 'fixing it and saving runs them again and they pass');
    await click('#bottomActions button[data-action="autoTest"]');
    await shot('09-tests.png');
  });

  // ================================================================ 10. coverage and the profiler
  await stage('coverage-profile', async () => {
    if (HAVE_COVERAGE) {
      await openFile(t, 'test_shapes.py');
      await click('.run-more-btn');
      await until(`!!document.querySelector('.context-menu')`, 'More Actions');
      await clickMenu('with Coverage');
      await until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Run with Coverage')`, 'coverage install prompt', 30000);
      await click('.dialog-buttons .primary');
      await until(`!document.querySelector('.cov-install')`, 'coverage.py installed', 240000);
      await until(`ide.toolWindows.get('Coverage').isVisible() && [...document.querySelectorAll('.cov-item')].some(n => n.textContent.includes('figures.py'))`, 'coverage results', 90000);
      const row = await js(`[...document.querySelectorAll('.cov-item')].find(n => n.textContent.includes('figures.py'))?.textContent`);
      check(/\d+% \(\d+\/\d+\)/.test(row || ''), `Run with Coverage installs coverage.py and lists figures.py (${row})`);
      await openFile(t, 'geo/plane/figures.py');
      await until(`!!ide.editor.getDomNode().querySelector('.cov-line')`, 'coverage stripes', 15000);
      check(true, 'the editor shows coverage stripes');
      await shot('10-coverage.png');
    } else check(true, 'coverage.py is not available offline here: skipped');
    await openFile(t, 'main.py');
    await clickGutter(await findLine('if __name__'));
    await clickMenu("Profile 'main'");
    await until(`ide.toolWindows.get('Profiler').isVisible() && [...document.querySelectorAll('.pf-stats .pf-item')].some(n => n.textContent.includes('sum_areas'))`, 'profiler results', 90000);
    check(true, 'Profile from the gutter shows sum_areas in the Profiler statistics');
  });

  // ================================================================ 11. a scratch file and the Python Console
  await stage('scratch-console', async () => {
    await js('(ide.editor.focus(), true)');
    await press('Ctrl+Alt+Shift+Insert');
    await until(`!document.getElementById('popup').classList.contains('hidden')`, 'scratch language picker');
    await press('Enter');
    await until(`/scratch(_\\d+)?\\.py$/.test(ide.activeTab()?.path || '')`, 'scratch opened');
    await setAll('from geo.plane.figures import circle_area\n\nprint("scratch", round(circle_area(2), 1))\n');
    await saveActive();
    await press('Ctrl+Shift+F10');
    const title = await js(`ide.util.basename(ide.activeTab().path).replace(/\\.py$/, '')`);
    await runFinished(title);
    check((await runText(title)).includes('scratch 12.6'), 'a Python scratch runs in the project and imports its package');
    await press('Alt+8');
    await until(`ide.pyconsole.isRunning() && document.activeElement?.id === 'pyconsoleIn'`, 'Python Console', 60000);
    await type('from geo.plane.figures import Rect');
    await press('Enter');
    await type('Rect(3, 4).area');
    await press('Enter');
    await until(`document.querySelector('#pyconsoleOut').textContent.includes('>>> Rect(3, 4).area\\n12')`, 'console result', 30000);
    check(true, 'the Python Console imports the project package and evaluates');
    await press('Alt+8');
  });

  // ================================================================ 12. a package from an unresolved import quick fix
  await stage('install', async () => {
    await openFile(t, 'main.py');
    await js(`(ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await paste('import flow_units\n');
    await toEnd();
    await paste('\n\ndef inches(n):\n    return flow_units.to_cm(n)\n');
    await saveActive();
    const missing = `ide.lsp.diagnostics(ide.activeTab().path).some(d => d.code === 'reportMissingImports' && d.range.start.line === 0)`;
    await until(missing, 'flow_units unresolved', 60000);
    // the diagnostic moves with an edit made before Pyright reports again (checked within one task)
    const shift = await js(`(() => { const p = ide.activeTab().path, at = () => ide.lsp.diagnostics(p).find(d => d.code === 'reportMissingImports')?.range.start.line;
      const before = at(); ide.editor.executeEdits('flow', [{ range: new ide.monaco.Range(1, 1, 1, 1), text: '# note\\n' }]); const after = at();
      ide.editor.trigger('flow', 'undo', null); return [before, after]; })()`);
    check(shift[0] === 0 && shift[1] === 1, `Pyright's diagnostics follow edits made before it reports again (lines ${J(shift)})`);
    await caret(1, 10);
    await sleep(400);
    await press('Alt+Enter');
    const fix = `[...document.querySelectorAll('.action-widget .monaco-list-row.action')].find(n => n.textContent.includes("Install package 'flow-units'"))`;
    await until(`!!${fix}`, 'install quick fix', 30000);
    for (let i = 0; i < 12 && !(await js(`!!${fix}?.classList.contains('focused')`)); i++) await press('ArrowDown');
    await press('Enter');
    await until(`/Successfully installed flow[-_]units-1\\.2\\.0/i.test(document.querySelector('#pkgOut')?.textContent || '')`, 'flow-units installed', 120000);
    await until(`!(${missing})`, 'import resolved', 60000);
    check(true, 'the quick fix installs the package offline and the import resolves');
    const out = sh(file('.venv/Scripts/python.exe'), ['-c', 'import main; print(main.inches(2))'], { cwd: P }).trim();
    check(out === '5.08', `the installed package works (${out})`);
  });

  // ================================================================ 13. before launch task and a file watcher
  await stage('automation', async () => {
    mkdirSync(file('tools'), { recursive: true });
    writeFileSync(file('tools/gen_version.py'), 'import pathlib, time\n\npathlib.Path("geo/_version.py").write_text(f"BUILT = {time.time_ns()}\\n")\nprint("version written")\n');
    writeFileSync(file('tools/count_lines.py'), 'import pathlib, sys\n\np = pathlib.Path(sys.argv[1])\npathlib.Path(str(p) + ".count").write_text(str(len(p.read_text().splitlines())))\nprint("counted", p.name)\n');
    await openFile(t, 'main.py');
    await click('.run-target');
    await clickMenu("main");
    await click('.run-target');
    await clickMenu('Edit Configurations');
    await until(`!!document.querySelector('.rc-bl')`, 'Before launch section');
    await clickSeen('.rc-bl-bar [data-bl="add"]');
    await clickMenu('Run External Tool');
    await until(`!!document.querySelector('[data-bl-key="program"]')`, 'tool fields');
    await setInput('[data-bl-key="name"]', 'Generate version');
    await setInput('[data-bl-key="program"]', '$PyInterpreterPath$');
    await setInput('[data-bl-key="args"]', 'tools/gen_version.py');
    await shot('13-before-launch.png');
    await js(`[...document.querySelectorAll('.dialog-buttons button')].reverse().find(b => b.textContent === 'OK').click()`);
    await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
    await click('.run-btn');
    await runFinished('Generate version');
    await until(`(ide.run.sessions().find(s => s.title === 'main')?.con?.out?.textContent || '').includes('exit code') && !ide.run.sessions().find(s => s.title === 'main').running`, 'main after the tool', 60000);
    check(existsSync(file('geo/_version.py')) && (await runText('Generate version')).includes('version written'), 'the before launch tool runs first, in its own Run tab');
    // a File Watcher on *.txt
    await js(`(ide.openSettings('fileWatchers'), true)`);
    await until(`document.querySelector('.settings-page')?.dataset.page === 'fileWatchers'`, 'File Watchers page');
    await clickSeen('[data-fw="add"]');
    await clickMenu('Custom');
    await until(`!!document.querySelector('[data-fw-key="program"]')`, 'watcher form');
    await setInput('[data-fw-key="name"]', 'Count lines');
    await setInput('[data-fw-key="fileType"]', '*.txt');
    await setInput('[data-fw-key="program"]', '$PyInterpreterPath$');
    await setInput('[data-fw-key="args"]', '$ProjectDir$/tools/count_lines.py $FilePath$');
    await click('#settingsOk');
    await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
    writeFileSync(file('points.txt'), 'x,y\n');
    await js(`ide.refreshTree()`);
    await openFile(t, 'points.txt');
    await toEnd();
    await paste('1,2\n3,4\n');
    await saveActive();
    await until(`(async () => await ide.api.exists(${J(file('points.txt.count'))}))()`, 'watcher output', 30000);
    await until(`!ide.fileWatchers.busy()`, 'watchers idle', 30000);
    check(readFileSync(file('points.txt.count'), 'utf8') === '3', 'saving a .txt file runs the File Watcher with the file\'s path');
  });

  // ================================================================ 14. local history, bookmarks, Search Everywhere, Paste from History
  await stage('history-navigation', async () => {
    await openFile(t, 'main.py');
    const good = await text();
    // an accident: the whole make_shapes function deleted and saved
    const from = await findLine('def make_shapes');
    await js(`(() => { const e = ide.editor; e.executeEdits('flow', [{ range: new ide.monaco.Range(${from}, 1, ${from + 3}, 1), text: '' }]); return true; })()`);
    await saveActive();
    await js(`(ide.runAction('LocalHistory.ShowHistory'), true)`);
    await until(`ide.activeTab()?.title === 'Local History: main.py' && document.querySelectorAll('.lh-view:not(.hidden) .lh-row').length >= 2`, 'local history');
    await js(`(() => { const rows = [...document.querySelectorAll('.lh-view:not(.hidden) .lh-row:not(.label)')]; rows[1].id = 'lhPick'; return true; })()`);
    await click('#lhPick');
    await until(`document.querySelector('.lh-view:not(.hidden) .lh-row.selected')?.id === 'lhPick'`, 'revision selected');
    await shot('14-local-history.png');
    await click('.lh-view:not(.hidden) .lh-revert');
    await until(`(async () => (await ide.api.read(${J(file('main.py'))})).includes('def make_shapes'))()`, 'reverted', 15000);
    check(read('main.py') === good.replace(/\r\n/g, '\n'), 'Local History reverts main.py to the revision before the accident');
    await js(`(ide.closeTab(ide.activeTab().path ?? ide.activeTab().id), true)`).catch(() => {});
    // bookmarks
    await openFile(t, 'geo/plane/figures.py');
    await caretAt('def sum_areas', 1);
    await press('Ctrl+F11');
    await until(`document.activeElement?.classList.contains('bm-grid')`, 'mnemonic grid');
    await press('1');
    await until(`ide.bookmarks.list().some(m => m.mnemonic === '1')`, 'bookmark 1');
    await openFile(t, 'main.py');
    await press('Ctrl+1');
    await until(`ide.activeTab()?.title === 'figures.py' && ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).startsWith('def sum_areas')`, 'jumped to bookmark 1');
    check(true, 'Ctrl+F11 1 sets a numbered bookmark and Ctrl+1 jumps back to it');
    // Search Everywhere
    await openFile(t, 'main.py');
    await press('Shift');
    await press('Shift');
    await until(`!!document.querySelector('#seInput')`, 'Search Everywhere');
    await js(`document.querySelector('#seInput').select()`);
    await type('circle_area');
    await until(`[...document.querySelectorAll('#searchEverywhere .se-row, #searchEverywhere [class*="row"]')].some(r => r.textContent.includes('circle_area'))`, 'symbol found', 30000);
    await sleep(300);
    await press('Enter');
    await until(`ide.activeTab()?.title === 'figures.py' && ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).includes('def circle_area')`, 'Search Everywhere jump', 15000);
    check(true, 'Double Shift finds circle_area and Enter opens it');
    // Paste from History
    await openFile(t, 'main.py');
    const l1 = await findLine('def main');
    await js(`(ide.editor.setSelection(new ide.monaco.Selection(${l1}, 5, ${l1}, 9)), ide.editor.focus(), true)`);
    await ctrlChord('C');
    const l2 = await findLine('def make_shapes');
    await js(`(ide.editor.setSelection(new ide.monaco.Selection(${l2}, 5, ${l2}, 16)), ide.editor.focus(), true)`);
    await ctrlChord('C');
    await until(`ide.clipboardHistory.items()[0]?.text === 'make_shapes' && ide.clipboardHistory.items()[1]?.text === 'main'`, 'copies recorded');
    await toEnd();
    await enter();
    await press('Ctrl+Shift+V');
    await until(`!!document.querySelector('#pasteFromHistory')`, 'Paste from History');
    await press('ArrowDown');
    await press('Enter');
    await until(`!document.querySelector('#pasteFromHistory')`, 'pasted');
    const lastLine = await js(`(() => { const m = ide.editor.getModel(); return m.getLineContent(m.getLineCount()); })()`);
    check(lastLine === 'main', `Ctrl+Shift+V pastes the older copy (${J(lastLine)})`);
    await js(`(ide.editor.trigger('flow', 'undo', null), ide.editor.trigger('flow', 'undo', null), true)`);
    await saveActive();
    check(read('main.py') === good.replace(/\r\n/g, '\n'), 'main.py is back as it was');
  });

  // ================================================================ 15. power save, font zoom, layouts
  await stage('comfort', async () => {
    await js(`(ide.runAction('TogglePowerSave'), true)`);
    await until(`ide.powerSave.on() && !document.querySelector('#powerSaveStatus').classList.contains('hidden')`, 'power save on');
    check(true, 'Power Save Mode turns on with its status indicator');
    await js(`(ide.runAction('TogglePowerSave'), true)`);
    await until(`!ide.powerSave.on() && document.querySelector('#powerSaveStatus').classList.contains('hidden')`, 'power save off');
    const altShift = async (ch) => {
      const base = { modifiers: 1 | 8, key: ch === '.' ? '>' : '<', code: ch === '.' ? 'Period' : 'Comma', windowsVirtualKeyCode: ch === '.' ? 190 : 188 };
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    };
    await js('(ide.editor.focus(), true)');
    const size = await js(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize)`);
    await altShift('.');
    await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === ${size + 1} && !document.querySelector('#fontZoomHint').classList.contains('hidden')`, 'font bigger');
    await altShift(',');
    await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === ${size}`, 'font back');
    check(true, 'Alt+Shift+. and Alt+Shift+, zoom the editor font in and out');
    await js(`(ide.runAction('StoreNewLayout'), true)`);
    await until(`document.activeElement?.id === 'layoutName'`, 'layout name dialog');
    await js(`(document.getElementById('layoutName').value = '', true)`);
    await type('Coding');
    await press('Enter');
    await until(`ide.layouts.list().includes('Coding') && ide.layouts.current() === 'Coding'`, 'layout saved');
    const shown = () => js(`[...ide.toolWindows.values()].filter(w => w.isVisible()).map(w => w.id).sort().join()`);
    const before = await shown();
    await js(`([...ide.toolWindows.values()].forEach(w => w.isVisible() && w.hide()), ide.editor.focus(), true)`);
    await press('Shift+F12');
    await until(`[...ide.toolWindows.values()].filter(w => w.isVisible()).map(w => w.id).sort().join() === ${J(before)}`, 'layout restored');
    check(true, `Save Current Layout As… and Shift+F12 bring the tool windows back (${before})`);
  });

  // ================================================================ 16. close the project and quit: nothing left behind
  {
    console.log('---- close-quit');
    const errs = await internalErrors();
    check(!errs.length, `no internal errors in the whole session${errs.length ? ` ${J(errs.map((e) => e.title || e.message))}` : ''}`);
    const log = readFileSync(path.join(t.userData, 'logs', 'pyide.log'), 'utf8');
    const severe = log.split('\n').filter((l) => / ERROR - /.test(l));
    check(!severe.length, `the IDE log has no ERROR lines${severe.length ? ` ${J(severe.slice(0, 5))}` : ''}`);
    await js(`(ide.saveAll(), true)`);
    await js(`ide.closeProject()`);
    await until(`!document.querySelector('#welcome').classList.contains('hidden')`, 'welcome screen', 30000);
    await until(`!ide.run.sessions().some(s => s.running)`, 'no runs', 15000).catch(() => {});
    let left = [];
    for (let i = 0; i < 40; i++) { left = projectPythons(); if (!left.length) break; await sleep(500); }
    check(!left.length, `closing the project ends every Python process it started${left.length ? ` ${J(left)}` : ''}`);
    const tree = processTree(t.pid);
    const electronPid = t.pid;
    await js(`(ide.runAction('Exit'), true)`).catch(() => {});
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) { try { process.kill(electronPid, 0); await sleep(500); } catch { gone = true; } }
    check(gone, 'File › Exit quits PyIDE');
    let stay = [];
    for (let i = 0; i < 20; i++) { stay = liveProcesses(tree); if (!stay.length) break; await sleep(500); }
    check(!stay.length, `no process PyIDE started is left after quitting${stay.length ? ` ${J(stay.map((p) => `${p.name} ${p.cmd.slice(0, 120)}`))}` : ''}`);
  }
} catch (err) {
  if (/FLOW_STOP/.test(err.message)) console.log(err.message); else check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.finish();
