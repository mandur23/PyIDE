// Settings dialog layout, validation, language switching and plugin management, including what survives a restart.
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const navRows = (t) => t.js(`[...document.querySelectorAll('.settings-nav-row')].filter(n => n.offsetParent).map(n => n.textContent.replace(/[▾▸]/g, '')).join('|')`);
const openPage = async (t, page) => {
  await t.click(`.settings-nav-row[data-page="${page}"]`);
  await t.until(`document.querySelector('.settings-page').dataset.page === '${page}'`, `page ${page}`);
};

let a;
try {
  a = await launch({ fixture: 'core', port: 9450, name: 'settings' });
  await openFile(a, 'hello.py');

  // ---------- layout ----------
  await a.press('Ctrl+Alt+S');
  await a.until(`!!document.querySelector('.settings-dialog')`, 'settings dialog');
  // Plugins add their own pages (under Editor, under AI, or at the end), so the core tree is checked in order around them.
  const tree = await navRows(a);
  check(tree.startsWith('Appearance & Behavior|Appearance|Language and Region|Keymap|Editor|General|Code Style|') && tree.includes('|Plugins|Project: project|Python Interpreter|Tools|AI|AI Completion|Claude Edits'),
    `category tree lists groups and pages, plugin pages under AI (${tree})`);
  const indents = await a.js(`(() => { const x = (sel) => [...document.querySelectorAll(sel)].map(n => Math.round(n.querySelector('.settings-nav-label').getBoundingClientRect().left)); return { top: [...new Set(x('.settings-nav-row:not(.child)'))], child: [...new Set(x('.settings-nav-row.child'))] }; })()`);
  check(indents.top.length === 1 && indents.child.length === 1 && indents.child[0] > indents.top[0], `top-level and child labels each share one indent (${JSON.stringify(indents)})`);
  await a.click('.settings-nav-row.settings-group[data-group="editor-group"]');
  check(!(await navRows(a)).includes('General'), 'clicking a group collapses it');
  await a.click('.settings-nav-row.settings-group[data-group="editor-group"]');
  check((await navRows(a)).includes('General|Code Style') && (await a.js(`document.querySelector('.settings-page').dataset.page`)) === 'editor', 'expanding a group opens its first page');
  check(await a.js(`document.querySelector('.settings-crumb').textContent.replace(/\\s+/g, '') === 'Editor›General'`), 'breadcrumb shows group › page');

  // ---------- validation ----------
  await a.js(`(() => { const i = document.querySelector('[data-key="editor.fontSize"]'); i.focus(); i.select(); })()`);
  await a.type('0');
  check(await a.js(`document.querySelector('[data-key="editor.fontSize"]').classList.contains('invalid') && document.querySelector('#settingsApply').disabled`), 'out-of-range font size is flagged and not applied');
  await a.js(`document.querySelector('[data-key="editor.fontSize"]').select()`);
  await a.type('16');
  check(await a.js(`!document.querySelector('[data-key="editor.fontSize"]').classList.contains('invalid') && !document.querySelector('#settingsApply').disabled`), 'valid font size becomes a pending change');
  await a.click('#settingsApply');
  await a.until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 16`, 'font applied');
  check(true, 'Apply changes the editor font live');

  // ---------- search ----------
  await a.js(`document.querySelector('.settings-search').focus()`);
  await a.type('shortcut');
  check((await navRows(a)) === 'Keymap', 'search finds the Keymap page by keyword');
  await a.until(`document.querySelector('.settings-page').dataset.page === 'keymap'`, 'keymap page');
  check(await a.js(`[...document.querySelectorAll('.keymap-row')].some(r => r.textContent.includes('Find Action') && r.textContent.includes('Ctrl+Shift+A'))`), 'keymap lists actions with shortcuts');
  await a.js(`(() => { const s = document.querySelector('.settings-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);

  // ---------- small window ----------
  await a.cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  await a.sleep(300);
  const box = await a.js(`(() => { const r = document.querySelector('.settings-dialog').getBoundingClientRect(); const b = document.querySelector('#settingsOk').getBoundingClientRect(); return { right: r.right, bottom: r.bottom, okBottom: b.bottom, w: innerWidth, h: innerHeight }; })()`);
  check(box.right <= box.w && box.bottom <= box.h && box.okBottom <= box.h, `dialog fits a 900x560 window (${JSON.stringify(box)})`);
  await a.shot('small-window.png');
  await a.cdp('Emulation.clearDeviceMetricsOverride');

  // ---------- new virtualenv form stays inside the dialog ----------
  await openPage(a, 'interpreter');
  await a.click('#addInterpBtn');
  await a.until(`!!document.querySelector('#addInterpMenu')`, 'add interpreter menu');
  await a.js(`[...document.querySelectorAll('#addInterpMenu .menu-item')][1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await a.until(`document.activeElement?.id === 'venvLocation'`, 'venv form focused');
  const fit = await a.js(`(() => {
    const dlg = document.querySelector('.settings-dialog').getBoundingClientRect();
    const scrolled = [...document.querySelectorAll('.settings, .settings-main, .settings-page, .settings-body')].some(n => n.scrollLeft > 0);
    const inside = ['#venvLocation', '#venvBase', '#venvCreate', '#addInterpBtn', '.settings-search'].every(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= dlg.left && r.right <= dlg.right; });
    return { scrolled, inside };
  })()`);
  check(!fit.scrolled && fit.inside, `the new virtualenv form fits the dialog without scrolling it sideways (${JSON.stringify(fit)})`);
  await a.js(`[...document.querySelectorAll('.venv-buttons button')].find(b => b.textContent === 'Cancel').click()`);

  // ---------- plugins ----------
  await openPage(a, 'plugins');
  await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length >= 12`, 'installed plugins listed');
  check(await a.js(`document.querySelector('.plugins-tab.active').dataset.tab === 'installed' && document.querySelector('#pluginsList .plugins-group').textContent.startsWith('Bundled')`), 'Installed tab lists bundled plugins');
  check(await a.js(`document.querySelector('#pluginsList .plugin-row[data-id="run"] .plugin-toggle').disabled`), 'required plugins cannot be disabled');
  await a.js(`(document.querySelector('#pluginsList .plugin-row[data-id="pyconsole"]').scrollIntoView({ block: 'center' }), true)`);
  await a.click('#pluginsList .plugin-row[data-id="pyconsole"]');
  await a.until(`document.querySelector('#pluginsDetail .plugin-detail-name')?.textContent === 'Python Console'`, 'pyconsole detail');
  await a.click('#pluginEnableBtn');
  check(await a.js(`!document.querySelector('#pluginsList .plugin-row[data-id="pyconsole"] .plugin-toggle').checked && !document.querySelector('#settingsApply').disabled`), 'disabling a plugin is a pending change');
  check(await a.js(`[...document.querySelectorAll('#pluginsDetail .plugin-badge')].some(b => b.textContent === 'Restart required')`), 'detail shows Restart required');

  await a.click('.plugins-tab[data-tab="marketplace"]');
  await a.until(`document.querySelectorAll('#pluginsList .plugin-row').length === 3`, 'marketplace lists the catalog');
  await a.click('#pluginsList .plugin-row[data-id="word-count"] .plugin-install');
  await a.until(`document.querySelector('#pluginsStatus').textContent.startsWith('Installed')`, 'installed from marketplace');
  check(await a.js(`document.querySelector('#pluginsList .plugin-row[data-id="word-count"] .plugin-install').disabled`), 'marketplace shows the plugin as installed');
  await a.click('#pluginsList .plugin-row[data-id="key-promoter"] .plugin-install');
  await a.until(`document.querySelector('#pluginsList .plugin-row[data-id="key-promoter"] .plugin-install').disabled`, 'key promoter installed');
  await a.click('.plugins-tab[data-tab="installed"]');
  check(await a.js(`document.querySelector('#pluginsList .plugins-group').textContent.startsWith('Downloaded (2)')`), 'Installed tab shows downloaded plugins');
  await a.click('#pluginsList .plugin-row[data-id="key-promoter"]');
  await a.until(`!!document.querySelector('#pluginUninstallBtn')`, 'uninstall button');
  await a.js(`(window.confirm = () => true, 0)`);
  await a.click('#pluginUninstallBtn');
  await a.until(`!document.querySelector('#pluginsList .plugin-row[data-id="key-promoter"]')`, 'uninstalled');
  check(true, 'uninstall removes a downloaded plugin');
  check(await a.js(`!document.querySelector('.settings-restart-note').classList.contains('hidden')`), 'footer says a restart is required');
  await a.shot('plugins.png');

  // ---------- language ----------
  await openPage(a, 'language');
  await a.js(`(() => { const s = document.querySelector('[data-key="appearance.language"]'); s.value = 'ko'; s.dispatchEvent(new Event('change')); })()`);
  await a.click('#settingsOk');
  await a.until(`!document.querySelector('.settings-dialog') && document.querySelector('.dialog-title')?.textContent === 'Restart IDE'`, 'restart prompt');
  check(true, 'OK with restart-only changes offers to restart');
  check(await a.js(`ide.settings.get('appearance.language') === 'ko'`), 'language preference saved');
  await a.js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Not Now').click()`);
  check(a.consoleErrors.length === 0, 'no renderer exceptions in the first session');
  a.close();

  // ---------- after restart ----------
  const b = await launch({ fixture: 'core', port: 9451, name: 'settings-restart', userData: a.userData, lang: 'en-US' });
  check(await b.js(`i18n.locale === 'ko' && document.documentElement.lang === 'ko'`), 'restart picks up the Korean language setting');
  check(await b.js(`!ide.toolWindows.has('PythonConsole') && ![...document.querySelectorAll('.bottom-tab')].some(t => /Python (Console|콘솔)/.test(t.textContent))`), 'disabled plugin does not load');
  await b.until(`!!document.querySelector('#wordCountStatus')`, 'word count status');
  await openFile(b, 'hello.py');
  await b.until(`/줄, 단어 \\d+개/.test(document.querySelector('#wordCountStatus').textContent)`, 'word count text');
  check(true, 'installed plugin loads, in Korean');
  check(await b.js(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 16`), 'editor font persisted');
  await b.press('Ctrl+Alt+S');
  await b.until(`!!document.querySelector('.settings-dialog')`, 'settings dialog (ko)');
  check(await b.js(`document.querySelector('.settings-dialog .dialog-title').textContent === '설정' && document.querySelector('.settings-nav-row[data-page="plugins"]').textContent.includes('플러그인')`), 'settings dialog is in Korean');
  for (const page of ['appearance', 'language', 'keymap', 'editor', 'codestyle', 'plugins', 'interpreter', 'tools']) {
    await openPage(b, page);
    await b.sleep(page === 'interpreter' ? 1500 : 250);
    const leaks = await englishLeaks(b, '.settings-dialog', ['Virtualenv', 'Bundled', 'vendor', 'bin']);
    const realLeaks = leaks.filter((l) => !(page === 'keymap' && l.where === 'SPAN' && /^[A-Z]/.test(l.text) && !/[가-힣]/.test(l.text)));
    check(!realLeaks.length, `settings page ${page} has no untranslated text${realLeaks.length ? `: ${JSON.stringify(realLeaks.slice(0, 5))}` : ''}`);
    if (page === 'plugins') await b.shot('plugins-ko.png');
  }
  const missing = (await missingTranslations(b)).filter((s) => !/^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(s) || true);
  console.log(`missing translations from other plugins (informational): ${missing.length}`);
  await b.shot('settings-ko.png');
  check(b.consoleErrors.length === 0, 'no renderer exceptions after restart');
  b.close();
} catch (err) {
  check(false, err.message);
  a?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
