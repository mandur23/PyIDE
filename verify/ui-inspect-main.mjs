// Main window layout and colours, measured: the status bar with every widget showing at 1600, 1280 and 900 px (one
// line, nothing past the window edge, the lowest-priority widgets hidden first), the toolbar with a long branch name and
// incoming/outgoing commits, the editor's minimum width beside two side panels, tool windows that fill their area,
// popups, menus and notification balloons in a 900x560 window, text contrast in Dark, Light and Sync with OS, and
// static checks of the stylesheets (CSS variables that exist, no two plugins defining the same class). English and
// Korean. Ports 9487-9489.
import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, tempDir } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = JSON.stringify;
let failed = 0;
const instances = [];
const wrap = (t) => (ok, label) => { if (!ok) failed++; t.check(ok, label); };

// ---------- static checks of the stylesheets (no window) ----------
const cssFiles = [path.join(APP, 'renderer/core/styles.css'), path.join(APP, 'renderer/core/notifications.css')];
const featuresDir = path.join(APP, 'renderer/features');
for (const f of readdirSync(featuresDir)) {
  try { readFileSync(path.join(featuresDir, f, 'style.css')); cssFiles.push(path.join(featuresDir, f, 'style.css')); } catch {}
}
const sources = cssFiles.map((f) => ({ f, plugin: f.includes(`${path.sep}features${path.sep}`) ? path.basename(path.dirname(f)) : 'core', css: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
const staticResults = [];
const staticCheck = (ok, label) => { staticResults.push(!!ok); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
{
  // Every var(--x) without a fallback names a variable some stylesheet or script defines (an undefined one silently
  // falls back to inherit/transparent: --gray6/--gray8/--gray10 were used 45 times and never defined).
  const defined = new Set();
  const scripts = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(css|js)$/.test(e.name)) scripts.push(readFileSync(p, 'utf8')); } };
  walk(path.join(APP, 'renderer'));
  for (const s of scripts) for (const m of s.matchAll(/(--[a-zA-Z][\w-]*)\s*:|setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(m[1] || m[2]);
  const undefinedVars = [];
  for (const { f, css } of sources) for (const m of css.matchAll(/var\((--[a-zA-Z][\w-]*)\s*\)/g)) if (!defined.has(m[1])) undefinedVars.push(`${path.basename(path.dirname(f))}/${path.basename(f)}: ${m[1]}`);
  staticCheck(!undefinedVars.length, `every CSS variable used without a fallback is defined (${undefinedVars.slice(0, 8).join(', ') || 'all defined'})`);
  // Plugin stylesheets all load into one page: a bare class rule defined by two plugins leaks from one into the other
  // (file-watchers' 26px .fw-tool button squeezed the frameworks tool windows; notebook's 1px .nb-sep hid the breadcrumb
  // separators; ai-chat's flex:1 .aic-status reached the AI Completion status widget).
  const owners = new Map();
  for (const { plugin, css } of sources) {
    if (plugin === 'core') continue;
    for (const [, sel] of css.replace(/@media[^{]*\{/g, '').matchAll(/([^{}]+)\{/g)) {
      for (const part of sel.split(',')) {
        const m = /^\s*\.([a-zA-Z][\w-]*)(?::[\w-]+(?:\([^)]*\))?)*\s*$/.exec(part);
        if (m) owners.set(m[1], new Set([...(owners.get(m[1]) || []), plugin]));
      }
    }
  }
  const shared = [...owners].filter(([, s]) => s.size > 1).map(([c, s]) => `.${c} (${[...s].join(', ')})`);
  staticCheck(!shared.length, `no class is defined as a bare rule by two plugins (${shared.join(', ') || 'none'})`);
}

// ---------- the project: a git repository on a long branch, 3 commits behind and 1 ahead of its upstream ----------
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const BRANCH = 'feature/a-rather-long-branch-name-for-the-toolbar';
function makeProject() {
  const base = tempDir('ui-inspect-repo');
  const dir = path.join(base, 'inspect_project');
  cpSync(path.join(APP, 'verify/fixtures/lsp'), dir, { recursive: true });
  mkdirSync(path.join(dir, 'pkg'));
  for (let i = 0; i < 14; i++) writeFileSync(path.join(dir, 'pkg', `module_with_a_long_name_${i}.py`), `# TODO: item ${i}\ndef f${i}():\n    return ${i}\n`);
  git(dir, 'init', '-q', '-b', BRANCH);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  const bare = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', '-b', BRANCH, bare, other);
  for (let i = 0; i < 3; i++) { writeFileSync(path.join(other, `o${i}.txt`), String(i)); git(other, 'add', '.'); git(other, 'commit', '-qm', `o${i}`); }
  git(other, 'push', '-q');
  writeFileSync(path.join(dir, 'local.txt'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'local');
  git(dir, 'fetch', '-q');
  return dir;
}

// ---------- in-page helpers ----------
const HELPERS = `(() => {
  if (window.__uiInspect) return true;
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  // The colour behind an element: its own and its ancestors' backgrounds blended down to the first opaque one.
  const bgOf = (n) => {
    const layers = [];
    for (let e = n; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let base = { r: 255, g: 255, b: 255 };
    for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
    return base;
  };
  const contrast = (n) => { const a = lum(parse(getComputedStyle(n).color)), b = lum(bgOf(n)); return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2); };
  const shown = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const box = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  // The status bar: its visible widgets, each on one line, inside the bar and the window, none overlapping the next.
  const status = () => {
    const bar = document.getElementById('status').getBoundingClientRect();
    const items = [...document.querySelectorAll('#status > *:not(#statusItems):not(.spacer), #statusItems > *')].filter(shown);
    const bad = [];
    const sorted = items.map((n) => ({ n, r: n.getBoundingClientRect() })).sort((a, b) => a.r.left - b.r.left);
    for (const { n, r } of sorted) {
      const name = n.id || n.className;
      if (r.right > innerWidth + 0.5 || r.left < -0.5) bad.push(name + ' outside the window');
      if (r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5 || r.height > 22) bad.push(name + ' taller than the bar (' + Math.round(r.height) + 'px)');
    }
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].r.right > sorted[i].r.left + 0.5) bad.push((sorted[i - 1].n.id || sorted[i - 1].n.className) + ' overlaps ' + (sorted[i].n.id || sorted[i].n.className));
    return { bad, shown: items.map((n) => n.id || n.className), overflow: [...document.querySelectorAll('#statusItems > .status-overflow')].map((n) => n.id || n.className) };
  };
  window.__uiInspect = { parse, lum, bgOf, contrast, shown, box, status };
  return true;
})()`;

async function setSize(t, w, h) {
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await t.until(`innerWidth === ${w} && innerHeight === ${h}`, `viewport ${w}x${h}`);
  await t.sleep(250); // the status bar refits in the next animation frame
}
const closeAll = async (t) => { for (let i = 0; i < 3; i++) await t.press('Escape'); await t.sleep(100); };

async function mainWindowChecks(t, lang) {
  const check = wrap(t);
  const { js, until, sleep } = t;
  const ko = lang === 'ko';
  await js(HELPERS);
  for (const f of ['models.py', 'errors.py', 'cli.py']) await openFile(t, f);
  await until(`!document.getElementById('vcsSync').classList.contains('hidden')`, 'incoming/outgoing commits in the toolbar', 30000);

  // Everything in the status bar at once: Power Save Mode, two background tasks, and three more plugin widgets.
  await js(`(ide.powerSave.set(true), true)`);
  await js(`(window.__tasks = [ide.tasks.start({ title: ${q(ko ? '프로젝트 파일 인덱싱 중' : 'Indexing project files')}, fraction: 0.4, onCancel() {} }), ide.tasks.start({ title: 'Downloading PyIDE 0.2.4', fraction: 0.6 })], true)`);
  await js(`(() => { for (const [order, text] of [[25, ${q(ko ? '원격 인터프리터에 연결하는 중' : 'Connecting to the remote interpreter')}], [31, ${q(ko ? 'HTTP 환경: 개발' : 'HTTP environment: development')}], [40, ${q(ko ? '업데이트하려면 다시 시작' : 'Restart to Update')}]]) { const n = ide.util.el('span', 'inspect-status-item', text); n.dataset.inspectOrder = order; ide.registerStatusItem({ order, el: n }); } return true; })()`);
  for (const theme of ['dark', 'light']) {
    await js(`(ide.settings.set('appearance.theme', '${theme}'), true)`);
    for (const [w, h] of [[1600, 1000], [1280, 800], [900, 560]]) {
      await setSize(t, w, h);
      const s = await js(`__uiInspect.status()`);
      check(!s.bad.length, `${lang} ${theme} ${w}px: every status bar widget is on one line inside the bar and the window, none overlapping (${s.bad.join('; ') || s.shown.length + ' shown'})`);
      check(['statusPos', 'statusEncoding', 'statusInterp'].every((id) => s.shown.includes(id)), `${lang} ${theme} ${w}px: caret position, encoding and interpreter always show`);
      // Whether everything fits depends on the fonts (the CI runner's Korean font is wider): what must hold is that
      // the first hidden widget would not fit if it were shown (the bar would overflow or the path drop below 120px).
      const needed = await js(`(() => {
        const bar = document.getElementById('status'), first = document.querySelector('#statusItems > .status-overflow');
        if (!first) return true;
        first.classList.remove('status-overflow');
        const path = document.getElementById('statusPath');
        // the same rule as the fit in renderer/core/ide.js: the bar overflows, or the path is cut below 120px
        const over = bar.scrollWidth > bar.clientWidth + 1 || (path.scrollWidth > path.clientWidth && path.clientWidth < 120);
        first.classList.add('status-overflow');
        return over;
      })()`);
      if (w === 1600) check(needed, `${lang} ${theme} 1600px: a widget is hidden only when it would not fit (${s.overflow.join(', ') || 'none hidden'})`);
      if (w === 900) {
        const orders = await js(`[...document.querySelectorAll('#statusItems > *')].filter(n => n.classList.contains('status-overflow') || __uiInspect.shown(n)).map(n => [Number(n.dataset.order), n.classList.contains('status-overflow')])`);
        const firstHidden = orders.findIndex(([, hidden]) => hidden);
        check(firstHidden > 0 && orders.slice(firstHidden).every(([, hidden]) => hidden), `${lang} ${theme} 900px: the widgets that do not fit are hidden from the highest order down (${q(orders)})`);
        check(s.shown.includes('bgTasks') && s.shown.includes('powerSaveStatus'), `${lang} ${theme} 900px: background tasks and Power Save Mode stay`);
        if (theme === 'light') await t.shot(`status-${lang}-900.png`);
      }
      // Toolbar: one line, the left group (project, branch, sync) clear of the run widget.
      const tb = await js(`(() => { const L = document.getElementById('toolbarLeft'), R = document.getElementById('toolbarRight'); const kids = [...L.children].filter(__uiInspect.shown); const b = document.querySelector('.vcs-branch'), nm = document.querySelector('.vcs-branch-name');
        return { leftEnd: Math.max(...kids.map(k => k.getBoundingClientRect().right)), rightStart: R.getBoundingClientRect().left, tall: [...document.querySelectorAll('#toolbar *')].filter(n => __uiInspect.shown(n) && n.getBoundingClientRect().height > 32).map(n => n.className),
          branchH: b.getBoundingClientRect().height, truncated: nm.scrollWidth > nm.clientWidth, title: b.title }; })()`);
      check(tb.leftEnd <= tb.rightStart && !tb.tall.length && tb.branchH <= 30, `${lang} ${theme} ${w}px: the toolbar stays on one line with the branch widget clear of the run widget (${Math.round(tb.leftEnd)} <= ${Math.round(tb.rightStart)}, ${tb.tall.join(',') || 'nothing taller than 32px'})`);
      if (w === 900) check(tb.truncated && tb.title.includes(BRANCH), `${lang} ${theme} 900px: the long branch name ends in an ellipsis and the tooltip has all of it (${tb.title})`);
    }
  }
  await js(`(document.querySelectorAll('.inspect-status-item').forEach(n => n.remove()), true)`);
  await setSize(t, 1280, 800);
  check((await js(`__uiInspect.status()`)).overflow.length === 0, `${lang}: wider again, every widget shows again`);

  // ---------- contrast in both themes ----------
  for (const theme of ['dark', 'light']) {
    await js(`(ide.settings.set('appearance.theme', '${theme}'), true)`);
    await sleep(150);
    const c = await js(`(() => ({ power: __uiInspect.contrast(document.querySelector('.power-save-label')),
      muted: (() => { const n = ide.util.el('div', 'muted', 'x'); document.getElementById('sideBody').appendChild(n); const v = __uiInspect.contrast(n); n.remove(); return v; })(),
      gray8: getComputedStyle(document.documentElement).getPropertyValue('--gray8').trim(), toolbarGray10: getComputedStyle(document.getElementById('toolbar')).getPropertyValue('--gray10').trim() }))()`);
    check(c.power >= 4.5, `${lang} ${theme}: the Power Save Mode label is readable (${c.power}:1)`);
    check(c.muted >= 3.5, `${lang} ${theme}: secondary (.muted) text on a panel is readable (${c.muted}:1)`);
    check(!!c.gray8 && !!c.toolbarGray10, `${lang} ${theme}: --gray8 and the toolbar's --gray10 are defined (${c.gray8}, ${c.toolbarGray10})`);
  }

  // ---------- small window: the editor keeps its width beside two side panels ----------
  await js(`(ide.settings.set('appearance.theme', 'dark'), ide.toolWindows.get('Project').show(), ide.toolWindows.get('Notifications').show(), true)`);
  await setSize(t, 900, 560);
  const widths = await js(`({ center: document.getElementById('center').getBoundingClientRect().width, side: document.getElementById('sidePanel').getBoundingClientRect().width, right: document.getElementById('rightPanel').getBoundingClientRect().width })`);
  check(widths.center >= 310 && widths.side >= 140 && widths.right >= 140, `${lang} 900px with both side panels: the editor keeps ${Math.round(widths.center)}px, the panels shrink (${Math.round(widths.side)}, ${Math.round(widths.right)})`);
  await js(`(ide.toolWindows.get('Notifications').hide(), true)`);

  // ---------- tool windows fill their area ----------
  await setSize(t, 1280, 800);
  for (const id of ['DjangoStructure', 'Endpoints', 'Project', 'Structure', 'TODO', 'Problems']) {
    if (!(await js(`ide.toolWindows.has(${q(id)})`))) continue;
    const r = await js(`(() => { const w = ide.toolWindows.get(${q(id)}); w.show(); const c = w.container.getBoundingClientRect(), p = w.area.body.getBoundingClientRect(); return { w: c.width, h: c.height, pw: p.width, ph: p.height }; })()`);
    check(Math.abs(r.w - r.pw) <= 1 && Math.abs(r.h - r.ph) <= 1, `${lang}: the ${id} tool window fills its area (${Math.round(r.w)}x${Math.round(r.h)} of ${Math.round(r.pw)}x${Math.round(r.ph)})`);
  }
  // The debugger's tabs keep one line in a narrow bottom panel.
  await js(`(ide.toolWindows.get('Debug').show(), true)`);
  await setSize(t, 900, 560);
  await js(`(ide.toolWindows.get('Notifications').show(), true)`);
  await sleep(200);
  const subtabs = await js(`[...document.querySelectorAll('.dbg-subtab')].filter(__uiInspect.shown).map(n => Math.round(n.getBoundingClientRect().height))`);
  check(subtabs.length && subtabs.every((h) => h <= 26), `${lang}: the Debug window's tabs stay on one line in a narrow panel (${subtabs.join(', ')}px)`);
  await js(`(ide.toolWindows.get('Notifications').hide(), ide.toolWindows.get('Debug').hide(), true)`);

  // ---------- popups, menus and balloons in a 900x560 window ----------
  await js(`(ide.notifications.clear(), true)`);
  await js(`(() => { for (let i = 0; i < 8; i++) ide.notifications.notify({ title: ${q(ko ? '패키지 설치에 실패했습니다' : 'Package installation failed')} + ' ' + i, text: ${q(ko ? '요구 사항 파일에서 패키지를 설치하는 동안 오류가 발생했습니다.' : 'An error occurred while installing packages from the requirements file.')}, kind: i % 2 ? 'error' : 'warning' }); return true; })()`);
  await sleep(150);
  const balloons = await js(`[...document.querySelectorAll('.ide-balloon')].map(__uiInspect.box)`);
  check(balloons.length >= 1 && balloons.every((b) => b.t >= 40 && b.b <= 560), `${lang}: 8 balloons in a short window: the oldest go, the ${balloons.length} left are all below the toolbar (${q(balloons.map((b) => b.t))})`);
  check(await js(`ide.notifications.list().length >= 8`), `${lang}: the dropped balloons stay in the notification log`);
  await t.shot(`balloons-${lang}-900.png`);
  await js(`(ide.notifications.clear(), true)`);

  for (const [action, sel, typed] of [['SearchEverywhere', '.se-popup', 'mod'], ['RunAnything', '.ra-popup', ''], ['PasteMultiple', '.ch-popup', ''], ['GotoAction', '#popup', 'e']]) {
    await js(`(ide.editor.focus(), ide.runAction(${q(action)}), true)`);
    await until(`__uiInspect.shown(document.querySelector(${q(sel)}))`, `${action} popup`);
    if (typed) { await t.type(typed); await sleep(500); }
    const b = await js(`__uiInspect.box(document.querySelector(${q(sel)}))`);
    check(b.t >= 0 && b.b <= 560 && b.r <= 900, `${lang}: the ${action} popup fits in a 900x560 window (${q(b)})`);
    if (action === 'SearchEverywhere') {
      await t.shot(`search-everywhere-${lang}-900.png`);
      const hint = await js(`(() => { const n = document.querySelector('.se-row.active .se-hint') || document.querySelector('.se-row.active .se-detail'); return n ? __uiInspect.contrast(n) : null; })()`);
      if (hint != null) check(hint >= 3, `${lang}: the selected row's shortcut or location is readable on its blue (${hint}:1)`);
    }
    await closeAll(t);
  }
  // A menu longer than the window scrolls inside it.
  await js(`(ide.ui.contextMenu(880, 540, Array.from({ length: 40 }, (_, i) => ({ label: 'Item ' + i, hint: 'Ctrl+' + i }))), true)`);
  const menu = await js(`(() => { const m = document.querySelector('.context-menu'); return { ...__uiInspect.box(m), scroll: m.scrollHeight > m.clientHeight }; })()`);
  check(menu.t >= 0 && menu.b <= 560 && menu.r <= 900 && menu.scroll, `${lang}: a 40-item menu at the bottom-right corner stays in the window and scrolls (${q(menu)})`);
  await js(`(() => { const rows = [...document.querySelectorAll('.context-menu .menu-item')]; rows[0].dispatchEvent(new MouseEvent('mouseenter')); return true; })()`);
  const sel = await js(`__uiInspect.contrast(document.querySelector('.context-menu .menu-item.active .hint-right'))`);
  check(sel >= 3, `${lang}: a selected menu row's shortcut is readable (${sel}:1)`);
  await closeAll(t);

  // ---------- the editor ----------
  await setSize(t, 1280, 800);
  await openFile(t, 'models.py');
  await js(`(ide.editor.setPosition({ lineNumber: 12, column: 9 }), ide.editor.focus(), true)`);
  check(await js(`getComputedStyle(ide.editor.getDomNode()).outlineStyle === 'none' || getComputedStyle(ide.editor.getDomNode()).outlineWidth === '0px'`), `${lang}: a focused editor has no blue frame around the pane`);
  await until(`document.querySelectorAll('.nb-bar .nb-crumb-sep').length > 0`, 'breadcrumbs with a symbol', 45000);
  const crumbSep = await js(`(() => { const n = document.querySelector('.nb-bar .nb-crumb-sep'); return { w: n.getBoundingClientRect().width, bg: getComputedStyle(n).backgroundColor, text: n.textContent }; })()`);
  check(crumbSep.w > 2 && crumbSep.text === '›' && /rgba\(0, 0, 0, 0\)|transparent/.test(crumbSep.bg), `${lang}: breadcrumb separators show their › (${q(crumbSep)})`);
  check(await js(`getComputedStyle(document.getElementById('aiCompleteStatus') || document.body).flexGrow === '0'`), `${lang}: the AI Completion status widget does not take ai-chat's flex: 1`);
  await js(`(window.__tasks.forEach(x => x.done()), ide.powerSave.set(false), true)`);
}

try {
  // =====================================================================================
  // A, B: English and Korean on a dark OS.
  // =====================================================================================
  for (const [lang, port] of [['en-US', 9487], ['ko-KR', 9488]]) {
    const t = await launch({ projectDir: makeProject(), port, name: 'inspect-main', lang });
    instances.push(t);
    await mainWindowChecks(t, lang === 'ko-KR' ? 'ko' : 'en');
    if (lang === 'ko-KR') {
      const missing = (await missingTranslations(t)).filter((s) => /status|toolbar|branch/i.test(s));
      wrap(t)(!missing.length, `Korean: no missing translations in what this suite showed (${missing.join(', ') || 'none'})`);
    }
    t.close();
  }

  // =====================================================================================
  // C: Sync with OS on a light OS, then the OS switching to dark.
  // =====================================================================================
  const c = await launch({ projectDir: makeProject(), port: 9489, name: 'inspect-main', env: { PYIDE_OS_THEME: 'light' } });
  instances.push(c);
  const check = wrap(c);
  await c.js(HELPERS);
  await openFile(c, 'errors.py');
  await c.js(`(ide.settings.set('appearance.theme', 'system'), ide.powerSave.set(true), ide.toolWindows.get('Problems').show(), true)`);
  await c.until(`document.documentElement.dataset.theme === 'light'`, 'Sync with OS on a light OS');
  // No dark leftovers: outside the (deliberately dark) main toolbar, editors and terminals nothing has a dark background.
  const dark = `[...document.querySelectorAll('body *')].filter(n => __uiInspect.shown(n) && !n.closest('#toolbar, .monaco-editor, .xterm, svg, .file-icon, .project-avatar')).filter(n => { const r = n.getBoundingClientRect(), c = __uiInspect.parse(getComputedStyle(n).backgroundColor); return r.width > 6 && r.height > 6 && c && c.a > 0.5 && __uiInspect.lum(c) < 0.12; }).map(n => n.id || n.className)`;
  const leftovers = await c.js(dark);
  check(!leftovers.length, `Sync with OS, light: no dark backgrounds outside the toolbar and editors (${leftovers.slice(0, 6).join(', ') || 'none'})`);
  const warn = await c.js(`(() => { const n = document.querySelector('.problem .sev.warning'); return n ? __uiInspect.contrast(n) : null; })()`);
  if (warn != null) check(warn >= 3, `Sync with OS, light: the Problems warning sign stands out on white (${warn}:1)`);
  check(await c.js(`__uiInspect.contrast(document.querySelector('.power-save-label'))`) >= 4.5, 'Sync with OS, light: Power Save Mode is readable');
  await c.shot('sync-light.png');
  await c.js(`ide.api.invoke('theme:testSetOs', 'dark')`);
  await c.until(`document.documentElement.dataset.theme === 'dark'`, 'the OS switched to dark');
  const darkMuted = await c.js(`(() => { const n = ide.util.el('div', 'muted', 'x'); document.getElementById('bottomBody').appendChild(n); const v = __uiInspect.contrast(n); n.remove(); return v; })()`);
  check(darkMuted >= 3.5, `Sync with OS, then a dark OS: secondary text stays readable (${darkMuted}:1)`);
  const s = await c.js(`__uiInspect.status()`);
  check(!s.bad.length, `Sync with OS, dark: the status bar is in order (${s.bad.join('; ') || 'ok'})`);
  c.close();
} catch (err) {
  failed++;
  console.log(`FAIL ${err.message}`);
}
for (const t of instances) { if (t.consoleErrors.length) { failed++; console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`); } }
const total = staticResults.length + instances.reduce((n, t) => n + t.results.length, 0);
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
