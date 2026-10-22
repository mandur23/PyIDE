// Line separators (core editors.js + the line-separators plugin): detection of LF, CRLF, CR and mixed files, the status
// bar widget and its menu, conversion as one undo step, saving in the file's own separator, the new-file setting
// (New Python File, file templates), Korean text, reload from disk, the widget's place when the status bar is crowded,
// and the Korean UI. Ports 9381-9382.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const FILES = {
  'lf.py': 'a = 1\nb = 2\nc = 3\n',
  'crlf.py': 'a = 1\r\nb = 2\r\nc = 3\r\n',
  'cr.txt': 'one\rtwo\rthree\r',
  'mixed.py': 'x = 1\r\ny = 2\r\nz = 3\nw = 4\r\n',
  'korean.py': '# 한글 주석입니다\r\nprint("안녕하세요")\r\n',
  'oneline.py': 'print(1)',
};
const sepCounts = (s) => ({ crlf: (s.match(/\r\n/g) || []).length, lf: (s.match(/(?<!\r)\n/g) || []).length, cr: (s.match(/\r(?!\n)/g) || []).length });

let t = await launch({ fixture: 'line-endings', port: 9381 });
try {
  const { js, until, check, press, sleep, cdp } = t;
  const disk = (f) => readFileSync(path.join(t.project, f), 'utf8');
  for (const [f, text] of Object.entries(FILES)) writeFileSync(path.join(t.project, f), text);
  const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
  const open = async (f) => {
    await js(`ide.openFile(${P(f)}).then(() => true)`);
    await until(`ide.activeTab()?.path.toLowerCase().endsWith(${S(f.toLowerCase())})`, `tab ${f}`);
  };
  const widget = () => js(`(() => { const n = document.getElementById('statusLineSeparator'); return n && !n.hidden && n.getClientRects().length ? { text: n.textContent, title: n.title } : null; })()`);
  const doc = (f) => `ide.getDocument(${P(f)})`;
  const dirty = (f) => js(`ide.isDirty(ide.findTab(${P(f)}))`);
  const save = (f) => js(`ide.saveTab(ide.findTab(${P(f)})).then(() => true)`);
  const edit = (f, text) => js(`(() => { const m = ${doc(f)}.model; m.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: ${S(text)} }], () => null); return true; })()`);
  const mouse = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(80); };
  const clickMenu = async (label) => {
    const box = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.querySelector('.menu-label')?.textContent === ${S(label)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!box) throw new Error(`no menu item ${label}`);
    await mouse(box.x, box.y);
  };
  const openWidgetMenu = async () => {
    await t.click('#statusLineSeparator');
    await until(`!!document.getElementById('lineSeparatorMenu')`, 'line separator menu');
  };

  // ---------- detection ----------
  await open('lf.py');
  check((await widget())?.text === 'LF', 'an LF file shows LF in the status bar');
  check(await js(`(() => { const s = document.getElementById('statusLineSeparator'); return s.previousElementSibling?.id === 'statusPos' && s.nextElementSibling?.id === 'statusEncoding'; })()`),
    'the widget sits between the caret position and the encoding, as in PyCharm');
  await open('crlf.py');
  check((await widget())?.text === 'CRLF' && (await js(`${doc('crlf.py')}.model.getEOL()`)) === '\r\n', 'a CRLF file shows CRLF and the model uses CRLF');
  await open('cr.txt');
  check((await widget())?.text === 'CR' && (await js(`${doc('cr.txt')}.model.getLineCount()`)) === 4, 'a CR file shows CR and has its three lines');
  await open('mixed.py');
  const mixed = await widget();
  check(mixed?.text === 'CRLF' && /mixed/i.test(mixed.title) && !(await dirty('mixed.py')), `a mixed file shows its main separator (CRLF), "mixed" in the tooltip, and opens unmodified (${S(mixed)})`);
  await open('korean.py');
  check((await widget())?.text === 'CRLF' && (await js(`${doc('korean.py')}.model.getLineContent(2)`)) === 'print("안녕하세요")', 'a CRLF file with Korean text is detected and read intact');
  await js(`(ide.settings.set('editor.lineSeparator', 'lf'), true)`);
  await open('oneline.py');
  check((await widget())?.text === 'LF', 'a file without any line break takes the new-file setting (LF)');

  // ---------- save keeps the separator ----------
  for (const [f, sep] of [['lf.py', 'lf'], ['crlf.py', 'crlf'], ['cr.txt', 'cr']]) {
    await edit(f, '# edited\n');
    await save(f);
    const c = sepCounts(disk(f));
    check(c[sep] === 4 && Object.entries(c).every(([k, n]) => k === sep || n === 0), `saving ${f} keeps only ${sep.toUpperCase()} (${S(c)})`);
  }
  await edit('mixed.py', '# edited\n');
  await save('mixed.py');
  const m = sepCounts(disk('mixed.py'));
  check(m.crlf === 5 && !m.lf && !m.cr, `saving the mixed file writes its main separator everywhere (${S(m)})`);
  await open('mixed.py');
  check(!/mixed/i.test((await widget())?.title || ''), 'after the save the tooltip no longer says mixed');
  await edit('korean.py', '# 저장\n');
  await save('korean.py');
  check(disk('korean.py') === '# 저장\r\n# 한글 주석입니다\r\nprint("안녕하세요")\r\n', 'saving a Korean CRLF file keeps the Korean text and CRLF');

  // ---------- convert from the widget, one undo step ----------
  await open('lf.py');
  await openWidgetMenu();
  check(await js(`[...document.querySelectorAll('#lineSeparatorMenu .menu-item')].map(n => n.textContent).join('|').includes('✓')`), 'the menu checks the current separator');
  await clickMenu('CRLF - Windows (\\r\\n)');
  await until(`document.getElementById('statusLineSeparator').textContent === 'CRLF'`, 'widget shows CRLF after converting');
  check((await js(`${doc('lf.py')}.model.getEOL()`)) === '\r\n' && await dirty('lf.py'), 'LF -> CRLF converts the model and marks the file modified');
  await js(`(ide.editor.focus(), true)`);
  await press('Ctrl+Z');
  await until(`document.getElementById('statusLineSeparator').textContent === 'LF'`, 'undo brings LF back');
  check((await js(`${doc('lf.py')}.model.getEOL()`)) === '\n' && !(await dirty('lf.py')), 'one Ctrl+Z undoes the whole conversion and the file is unmodified again');
  await press('Ctrl+Shift+Z');
  await until(`document.getElementById('statusLineSeparator').textContent === 'CRLF'`, 'redo converts again');
  check(await dirty('lf.py'), 'redo marks it modified again');
  await save('lf.py');
  const lfNow = sepCounts(disk('lf.py'));
  check(lfNow.crlf === 4 && !lfNow.lf, `the converted file is saved with CRLF (${S(lfNow)})`);

  // CRLF -> CR leaves Monaco's model as it is (CRLF), but is still one undo step that marks the file modified.
  await open('crlf.py');
  await openWidgetMenu();
  await clickMenu('CR - Classic Mac OS (\\r)');
  await until(`document.getElementById('statusLineSeparator').textContent === 'CR'`, 'widget shows CR');
  const crText = await js(`${doc('crlf.py')}.model.getValue()`);
  check(await dirty('crlf.py') && crText.startsWith('# edited\r\na = 1'), 'CRLF -> CR marks the file modified and keeps its text');
  await js(`(ide.editor.focus(), true)`);
  await press('Ctrl+Z');
  await until(`document.getElementById('statusLineSeparator').textContent === 'CRLF'`, 'undo brings CRLF back');
  check(!(await dirty('crlf.py')), 'undoing CRLF -> CR leaves the file unmodified');
  await press('Ctrl+Shift+Z');
  await until(`document.getElementById('statusLineSeparator').textContent === 'CR'`, 'redo to CR');
  await save('crlf.py');
  const crNow = sepCounts(disk('crlf.py'));
  check(crNow.cr === 4 && !crNow.crlf && !crNow.lf, `saved as CR (${S(crNow)})`);
  // The actions in Find Action convert too.
  await js(`(ide.runAction('ConvertToUnixLineSeparators'), true)`);
  await until(`document.getElementById('statusLineSeparator').textContent === 'LF'`, 'ConvertToUnixLineSeparators');
  await save('crlf.py');
  check(sepCounts(disk('crlf.py')).lf === 4 && !disk('crlf.py').includes('\r'), 'the Convert to LF action converts a CR file and it saves with LF');

  // Korean file: convert to LF and save, text intact.
  await open('korean.py');
  await js(`(ide.lineSeparators.convert(${doc('korean.py')}, '\\n'), true)`);
  await save('korean.py');
  check(disk('korean.py') === '# 저장\n# 한글 주석입니다\nprint("안녕하세요")\n', 'a Korean file converted to LF is saved with LF and the same text');

  // ---------- reload from disk follows the file ----------
  await open('mixed.py');
  writeFileSync(path.join(t.project, 'mixed.py'), 'p = 1\nq = 2\n');
  await js(`ide.reloadFromDisk([${P('mixed.py')}]).then(() => true)`);
  await until(`document.getElementById('statusLineSeparator').textContent === 'LF'`, 'reloaded file shows LF');
  check(!(await dirty('mixed.py')) && (await js(`${doc('mixed.py')}.model.getEOL()`)) === '\n', 'a file rewritten with LF on disk reloads as LF, unmodified');

  // ---------- new files ----------
  await js(`(ide.openSettings('codestyle'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'codestyle'`, 'Code Style page');
  const opts = await js(`(() => { const s = document.querySelector('.settings-page select[data-key="editor.lineSeparator"]'); return s && { value: s.value, options: [...s.options].map(o => o.value + '=' + o.textContent) }; })()`);
  check(opts?.value === 'lf' && opts.options.join('|') === 'system=System-Dependent|lf=Unix and macOS (\\n)|crlf=Windows (\\r\\n)', `Settings › Editor › Code Style has "Line separator for new files" (${S(opts)})`);
  await js(`(() => { const s = document.querySelector('.settings-page select[data-key="editor.lineSeparator"]'); s.value = 'crlf'; s.dispatchEvent(new Event('change')); [...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'OK').click(); return true; })()`);
  await until(`ide.settings.get('editor.lineSeparator') === 'crlf'`, 'setting saved by OK');
  check(true, 'choosing Windows (\\r\\n) and OK stores the setting');
  await js(`ide.fileTemplates.create('Python Unit Test', ide.root, 'test_crlf').then(() => true)`);
  await until(`ide.activeTab()?.path.endsWith('test_crlf.py')`, 'unit test file opened');
  const ut = sepCounts(disk('test_crlf.py'));
  check(ut.crlf === 10 && !ut.lf && (await widget())?.text === 'CRLF', `a new file from a template is written with CRLF and shows CRLF (${S(ut)})`);
  await js(`(ide.settings.set('editor.lineSeparator', 'lf'), true)`);
  await js(`ide.fileTemplates.create('HTML File', ide.root, 'page').then(() => true)`);
  await until(`ide.activeTab()?.path.endsWith('page.html')`, 'html file opened');
  const html = disk('page.html');
  check(!html.includes('\r') && html.includes('<title>page</title>') && (await widget())?.text === 'LF', 'with LF, a template file is written with LF');
  // Core's New Python File (empty template): the file has no line break, so it takes the setting.
  await js(`(ide.settings.set('editor.lineSeparator', 'crlf'), true)`);
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await until(`document.activeElement?.id === 'popupIn'`, 'name prompt');
  await js(`(document.getElementById('popupIn').value = '', true)`);
  await t.type('fresh');
  await press('Enter');
  await until(`ide.activeTab()?.path.endsWith('fresh.py')`, 'fresh.py opened');
  check((await widget())?.text === 'CRLF', 'an empty new Python file shows the new-file separator (CRLF)');
  await js(`(ide.editor.focus(), true)`);
  await t.type('x = 1\ny = 2');
  await save('fresh.py');
  check(disk('fresh.py').startsWith('x = 1\r\ny = 2'), `lines typed into it are saved with CRLF (${S(disk('fresh.py'))})`);
  await js(`(ide.settings.set('editor.lineSeparator', 'system'), true)`);
  check((await js(`ide.lineSeparators.newFile()`)) === '\r\n', 'System-dependent is CRLF on Windows');

  // ---------- status bar crowding ----------
  await open('lf.py');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  await js(`(() => { for (let i = 0; i < 8; i++) { const n = ide.util.el('span', 'crowd-item', 'Busy status widget number ' + i); n.dataset.crowd = ''; ide.registerStatusItem({ order: 50 + i, el: n }); } return true; })()`);
  await until(`document.querySelectorAll('#statusItems > .status-overflow').length > 0`, 'crowded status bar hides widgets');
  const crowd = await js(`(() => {
    const bar = document.getElementById('status');
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const sep = document.getElementById('statusLineSeparator');
    return { visible: !sep.hidden && sep.getClientRects().length > 0 && r('statusLineSeparator').width > 10,
      order: r('statusPos').right <= r('statusLineSeparator').left && r('statusLineSeparator').right <= r('statusEncoding').left,
      inside: r('statusLineSeparator').right <= bar.getBoundingClientRect().right, fits: bar.scrollWidth <= bar.clientWidth + 1,
      hidden: document.querySelectorAll('#statusItems > .status-overflow').length };
  })()`);
  check(crowd.visible && crowd.order && crowd.inside && crowd.fits, `when the status bar is crowded the widget stays visible between the caret position and the encoding while other widgets hide (${S(crowd)})`);
  await js(`(document.querySelectorAll('[data-crowd]').forEach(n => n.remove()), true)`);
  await cdp('Emulation.clearDeviceMetricsOverride');
  await js(`(ide.openCustomTab({ id: 'lsep:none', title: 'none', mount() {} }), true)`);
  check((await widget()) === null, 'a tab without a document hides the widget');
  await js(`(ide.closeTab('lsep:none', true), true)`);

  t.close();

  // ---------- Korean ----------
  const first = t;
  t = await launch({ fixture: 'line-endings', port: 9382, name: 'line-endings-ko', lang: 'ko-KR' });
  // The first instance's results count too.
  t.results.push(...first.results);
  t.consoleErrors.push(...first.consoleErrors);
  for (const [f, text] of Object.entries(FILES)) writeFileSync(path.join(t.project, f), text);
  await t.js(`ide.openFile(ide.util.joinPath(ide.root, 'mixed.py')).then(() => true)`);
  await t.until(`document.getElementById('statusLineSeparator')?.textContent === 'CRLF'`, 'ko widget');
  const koTitle = await t.js(`document.getElementById('statusLineSeparator').title`);
  t.check(koTitle.includes('줄 구분자: CRLF') && koTitle.includes('섞여'), `the tooltip is Korean (${S(koTitle)})`);
  await t.click('#statusLineSeparator');
  await t.until(`!!document.getElementById('lineSeparatorMenu')`, 'ko menu');
  const koMenu = await t.js(`document.getElementById('lineSeparatorMenu').textContent`);
  t.check(koMenu.includes('줄 구분자') && koMenu.includes('Unix 및 macOS') && koMenu.includes('클래식 Mac OS'), `the menu is Korean (${S(koMenu)})`);
  const leaks = await englishLeaks(t, '#lineSeparatorMenu, #statusLineSeparator');
  t.check(leaks.length === 0, `no English in the menu and status bar (${S(leaks)})`);
  await t.press('Escape');
  await t.js(`(ide.openSettings('codestyle'), true)`);
  await t.until(`document.querySelector('.settings-page')?.dataset.page === 'codestyle'`, 'ko Code Style page');
  const koPage = await t.js(`document.querySelector('.settings-page').textContent`);
  const koOpts = await t.js(`[...document.querySelector('.settings-page select[data-key="editor.lineSeparator"]').options].map(o => o.textContent).join('|')`);
  t.check(koPage.includes('새 파일의 줄 구분자') && koOpts === '시스템 종속|Unix 및 macOS(\\n)|Windows(\\r\\n)', `the Code Style row is Korean (${S(koOpts)})`);
  const missing = (await missingTranslations(t)).filter((s) => /separator|LF|CR|Unix|Windows|System-Dependent/i.test(s));
  t.check(missing.length === 0, `no missing Korean translations (${S(missing)})`);
} catch (e) {
  console.log(`FAIL ${e.stack || e}`);
  t.check(false, String(e.message || e));
}
t.finish();
