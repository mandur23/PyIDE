// End-to-end check for the scientific view (renderer/features/sciview, main/features/sciview.js): the Data View over
// real pandas / NumPy / polars objects in the Python Console, the debugger and a notebook kernel, and matplotlib
// figures from Run, the console and the debugger in the Plots tool window.
// The suite keeps a venv in verify/out/dataview-venv (ipykernel from pip on the first run); numpy, pandas, matplotlib
// and polars are installed into it through the Install Manager's pip items when missing. Ports 9720-9721.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const VENV = path.join(OUT, 'dataview-venv');
const VENV_PY = path.join(VENV, 'Scripts', 'python.exe');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, windowsHide: true });

function ensureVenv() {
  if (existsSync(VENV_PY)) {
    try { run(VENV_PY, ['-c', 'import ipykernel']); return; } catch {}
  } else {
    console.log('creating verify/out/dataview-venv (one time)…');
    try { run('py', ['-3', '-m', 'venv', VENV]); } catch { run('python', ['-m', 'venv', VENV]); }
  }
  run(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'ipykernel']);
}
ensureVenv();

const TMP = mkdtempSync(path.join(tmpdir(), 'pyide-dataview-out-'));

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${JSON.stringify(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${JSON.stringify(exe)})`, 'interpreter selected');
}

const DV = 'ide.activeTab().dataView';
const dvReady = (t, label, ms = 60000) => t.until(`!!${DV} && !${DV}.host.querySelector('.dv-c.wait') && ${DV}.host.querySelector('.dv-c') && !!${DV}.state().info`, label, ms);
const statusText = (t) => t.js(`${DV}.host.querySelector('.dv-status').textContent`);
const cellText = (t, r, c) => t.js(`${DV}.cellText(${r}, ${c})`);

// Runs a block in the Python Console and waits for the statement to finish ('pyconsoleChanged').
async function consoleRun(t, code, label) {
  const before = await t.js(`window.__pycDone ??= (ide.on('pyconsoleChanged', () => { window.__pycDone++; }), 0)`);
  await t.js(`ide.pyconsole.execute(${JSON.stringify(code)})`);
  await t.until(`window.__pycDone > ${before}`, label, 120000);
  await t.sleep(200);
}

// Clicks the "View as …" link in the row of a variables list that starts with `name`.
async function clickViewLink(t, rowsSelector, name) {
  const id = await t.js(`(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(rowsSelector)})].find((r) => (r.dataset.name || r.querySelector('.dbg-name')?.textContent) === ${JSON.stringify(name)});
    const a = row?.querySelector('.sv-view-link');
    if (!a) return null;
    a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    a.id ||= 'svLink' + Math.random().toString(36).slice(2);
    return a.id;
  })()`);
  if (!id) throw new Error(`no View link for ${name} in ${rowsSelector}`);
  await t.click(`#${id}`);
}

// Drags with real mouse events (column resize).
async function drag(t, selector, dx) {
  const p = await t.js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + (dx * i) / 6, y: p.y, button: 'left', buttons: 1 });
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
  await t.sleep(100);
}

// ---------- English session ----------
const t = await launch({ fixture: 'dataview', port: 9720, name: 'dataview' });
const { js, until, press, type, click, check, shot, sleep } = t;
try {
  await until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(t, VENV_PY);

  // ---------- Install Manager: the scientific stack through its pip items ----------
  check(await js(`['numpy', 'pandas', 'matplotlib', 'polars'].every((p) => ide.installables.some((i) => i.id === 'pip:' + p))`),
    'numpy, pandas, matplotlib and polars are listed in the Install Manager');
  for (const pkg of ['numpy', 'pandas', 'matplotlib', 'polars']) {
    const before = await js(`ide.installables.find((i) => i.id === 'pip:${pkg}').status()`);
    if (!before.installed) {
      console.log(`installing ${pkg} through the Install Manager…`);
      const err = await js(`(async () => {
        const item = ide.installables.find((i) => i.id === 'pip:${pkg}');
        const log = () => {}; log.raw = log;
        try { await item.install(log, () => {}, new AbortController().signal); return null; } catch (e) { return String(e.message || e); }
      })()`);
      if (err) console.log(`  ${pkg}: ${err}`);
    }
    const after = await js(`ide.installables.find((i) => i.id === 'pip:${pkg}').status()`);
    check(after.installed, `${pkg} is installed in the project interpreter (${after.version || 'missing'})${before.installed ? '' : ' by the Install Manager'}`);
  }
  check(await js(`(ide.settingsPages || []).some((p) => p.id === 'python-plots')`), 'Settings has a Python Plots page');

  // ---------- Python Console: variables pane, 1,000,000-row DataFrame ----------
  await js(`ide.toolWindows.get('PythonConsole').show()`);
  await until(`ide.pyconsole.isRunning() && document.querySelector('#pyconsolePrompt').textContent === '>>> '`, 'console prompt', 60000);
  await until(`!!document.querySelector('#pyconsoleVars')`, 'console variables pane');
  check(true, 'the Python Console shows a Variables pane');
  await consoleRun(t, [
    'import numpy as np, pandas as pd',
    'N = 1_000_000',
    'big = pd.DataFrame({"id": np.arange(N), "x": np.random.default_rng(0).random(N), "city": np.where(np.arange(N) % 4 == 0, "Seoul", "Busan")})',
    'big.loc[3, "x"] = np.nan',
    'cube = np.arange(60, dtype=float).reshape(3, 4, 5)',
    'recs = [{"name": "kim", "age": 31}, {"name": "lee", "age": None}, {"name": "park", "age": 25}]',
    'label = "not a table"',
  ].join('\n'), 'console block');
  await until(`['big', 'cube', 'recs', 'label'].every((n) => document.querySelector('#pyconsoleVars .sv-var[data-name="' + n + '"]'))`, 'variables listed', 30000);
  const varLinks = await js(`Object.fromEntries([...document.querySelectorAll('#pyconsoleVars .sv-var')].map((r) => [r.dataset.name, r.querySelector('.sv-view-link')?.textContent || '']))`);
  check(varLinks.big === 'View as DataFrame' && varLinks.recs === 'View as DataFrame' && varLinks.cube === 'View as Array' && !varLinks.label,
    `console variables offer View as DataFrame / View as Array only for tables (${JSON.stringify(varLinks)})`);
  check(/\{DataFrame: \(1000000, 3\)\}/.test(await js(`document.querySelector('#pyconsoleVars .sv-var[data-name="big"]').textContent`)), 'the variables pane shows the DataFrame type and shape');

  await clickViewLink(t, '#pyconsoleVars .sv-var', 'big');
  await until(`!!ide.activeTab()?.dataView`, 'data view tab');
  await dvReady(t, 'first page of big');
  check(await js(`ide.activeTab().title === 'big' && ide.activeTab().kind === 'custom'`), 'View as DataFrame opens an editor tab named after the variable');
  check(await statusText(t) === '1,000,000 rows × 3 columns', `status shows the size (${await statusText(t)})`);
  check(await js(`[...${DV}.host.querySelectorAll('.dv-h .dv-hn')].map((n) => n.textContent).join() === 'id,x,city'
    && [...${DV}.host.querySelectorAll('.dv-h .dv-ht')].map((n) => n.textContent).join().startsWith('int64,float64,')`), 'headers show column names and dtypes');
  check(await cellText(t, 0, 0) === '0' && await cellText(t, 2, 2) === 'Busan' && await cellText(t, 0, 2) === 'Seoul', 'the first rows show real values');
  check(await js(`${DV}.isMissing(3, 1) && ${DV}.host.querySelector('.dv-c.null[data-r="3"][data-c="1"]')?.textContent === 'NaN'`), 'NaN is shown dimmed');
  check(await js(`${DV}.host.querySelector('.dv-c.num[data-c="1"]') && getComputedStyle(${DV}.host.querySelector('.dv-c.num[data-c="1"]')).textAlign === 'right'`), 'numeric cells are right-aligned');

  // Paging: jump to the end; only a few blocks are ever fetched.
  await js(`${DV}.scrollToRow(999990)`);
  await until(`${DV}.cellText(999999, 0) === '999999'`, 'last row loaded', 30000);
  const paged = await js(`({ blocks: ${DV}.state().blocks, cells: ${DV}.host.querySelectorAll('.dv-c').length, label: ${DV}.indexLabel(999999) })`);
  check(paged.blocks <= 6 && paged.cells < 1500, `scrolling to row 999,999 fetches pages, not the table (${paged.blocks} blocks cached, ${paged.cells} cells in the DOM)`);
  check(paged.label === '999999', 'row labels come from the DataFrame index');
  await shot('dataview-big.png');

  // Sort by clicking the header (ascending, then descending; NaN stays last).
  await js(`${DV}.scrollToRow(0)`);
  await click(`.custom-tab:not(.hidden) .dv-h[data-c="1"]`);
  await until(`${DV}.state().sort?.join() === '1,true'`, 'sorted ascending');
  await dvReady(t, 'sorted page');
  const asc = [Number(await cellText(t, 0, 1)), Number(await cellText(t, 1, 1))];
  check(asc[0] <= asc[1] && asc[0] < 0.0001 && await js(`${DV}.host.querySelector('.dv-h[data-c="1"] .dv-hn').textContent.endsWith('▲')`), `clicking a header sorts ascending (${asc.join(', ')})`);
  await click(`.custom-tab:not(.hidden) .dv-h[data-c="1"]`);
  await until(`${DV}.state().sort?.join() === '1,false'`, 'sorted descending');
  await dvReady(t, 'sorted page desc');
  check(Number(await cellText(t, 0, 1)) > 0.9999, 'clicking again sorts descending');
  await js(`${DV}.scrollToRow(999990)`);
  await until(`${DV}.cellText(999999, 1) !== undefined`, 'end of sorted data', 30000);
  check(await js(`${DV}.isMissing(999999, 1) && ${DV}.indexLabel(999999) === '3'`), 'missing values sort last');
  await click(`.custom-tab:not(.hidden) .dv-h[data-c="1"]`);
  await until(`${DV}.state().sort === null`, 'unsorted');
  await js(`${DV}.scrollToRow(0)`);
  await until(`${DV}.cellText(5, 0) !== undefined`, 'unsorted page', 30000);
  check(await cellText(t, 5, 0) === '5', 'a third click restores the original order');

  // Filter expression typed into the filter field.
  await click(`.custom-tab:not(.hidden) .dv-filter`);
  await type(`city == 'Seoul' and x > 0.5`);
  await press('Enter');
  await until(`${DV}.state().filter === "city == 'Seoul' and x > 0.5"`, 'filter applied', 30000);
  await dvReady(t, 'filtered page');
  const filtered = await js(`${DV}.state().info.rows`);
  check(filtered > 120000 && filtered < 130000 && /^[\d,]+ of 1,000,000 rows × 3 columns$/.test(await statusText(t)), `the filter keeps ${filtered} rows (${await statusText(t)})`);
  check(await js(`[0, 1, 2, 3, 4].every((r) => ${DV}.cellText(r, 2) === 'Seoul' && Number(${DV}.cellText(r, 1)) > 0.5)`), 'every shown row matches the filter');
  await js(`${DV}.setSort(0, false)`);
  await dvReady(t, 'filtered + sorted');
  check(await js(`${DV}.cellText(0, 2) === 'Seoul' && Number(${DV}.cellText(0, 0)) > Number(${DV}.cellText(1, 0))`), 'sorting works on the filtered rows');
  await js(`${DV}.setSort(null)`);
  await js(`${DV}.host.querySelector('.dv-filter').select()`);
  await type('x >');
  await press('Enter');
  await until(`${DV}.host.querySelector('.dv-msg.error') && ${DV}.host.querySelector('.dv-filter.invalid')`, 'filter error shown', 30000);
  check(await js(`${DV}.state().info.rows === ${filtered} && /SyntaxError/.test(${DV}.host.querySelector('.dv-msg').textContent)`), 'a bad filter shows the Python error and keeps the rows');
  await js(`${DV}.setFilter('')`);
  await until(`${DV}.state().info.rows === 1000000 && !${DV}.host.querySelector('.dv-msg.error')`, 'filter cleared', 30000);
  check(true, 'an empty filter shows every row again');

  // Heatmap coloring, column resize, copy.
  await dvReady(t, 'page after clearing');
  await click(`.custom-tab:not(.hidden) .dv-colored`);
  await until(`${DV}.host.querySelector('.dv-c.num[style*="hsla"]')`, 'colored cells', 30000);
  check(await js(`!${DV}.host.querySelector('.dv-c:not(.num)[style*="hsla"]') && ${DV}.host.querySelector('.dv-colored').classList.contains('on')`), 'Colored tints numeric cells only');
  await click(`.custom-tab:not(.hidden) .dv-colored`);
  const w0 = await js(`${DV}.host.querySelector('.dv-h[data-c="2"]').getBoundingClientRect().width`);
  await drag(t, `.custom-tab:not(.hidden) .dv-rs[data-c="2"]`, 70);
  const w1 = await js(`${DV}.host.querySelector('.dv-h[data-c="2"]').getBoundingClientRect().width`);
  check(Math.abs(w1 - w0 - 70) < 4, `dragging a header edge resizes the column (${Math.round(w0)} → ${Math.round(w1)}px)`);
  await js(`${DV}.select(0, 0, 2, 1)`);
  await js(`${DV}.host.querySelector('.dv-grid').focus()`);
  await press('Ctrl+C');
  await until(`ide.api.invoke('clipboard:readText').then((s) => s.startsWith('0\\t'))`, 'clipboard has cells');
  const tsv = await js(`ide.api.invoke('clipboard:readText')`);
  const expect = `0\t${await cellText(t, 0, 1)}\r\n1\t${await cellText(t, 1, 1)}\r\n2\t${await cellText(t, 2, 1)}\r\n`;
  check(tsv === expect, 'Ctrl+C copies the selected cells as tab-separated text');
  await js(`${DV}.select(2, 0, 3, 2)`);
  await js(`${DV}.copy('csv', true)`);
  const csv = await js(`ide.api.invoke('clipboard:readText')`);
  check(csv.split('\r\n')[0] === ',id,x,city' && csv.split('\r\n')[2] === '3,3,,Busan', `Copy as CSV adds headers and leaves missing values empty (${JSON.stringify(csv.split('\r\n').slice(0, 3))})`);
  const csvFile = path.join(TMP, 'seoul.csv');
  await js(`${DV}.setFilter("city == 'Seoul' and id < 10")`);
  await js(`${DV}.exportCsv(${JSON.stringify(csvFile)})`);
  const exported = existsSync(csvFile) ? readFileSync(csvFile, 'utf8').trim().split(/\r?\n/) : [];
  check(exported.length === 4 && exported[0] === ',id,x,city' && exported[1].startsWith('0,0,'), `Export to CSV writes the filtered rows from Python (${exported.length} lines)`);
  await js(`${DV}.setFilter('')`);

  // NumPy array with more than two dimensions: a slice field.
  await clickViewLink(t, '#pyconsoleVars .sv-var', 'cube');
  await until(`ide.activeTab()?.title === 'cube'`, 'cube tab');
  await dvReady(t, 'cube page');
  check(await js(`!${DV}.host.querySelector('.dv-slice').classList.contains('hidden') && ${DV}.host.querySelector('.dv-slice-in').value === '[0, :, :]'`), 'a 3-D array opens at the slice [0, :, :]');
  check(await statusText(t) === '4 rows × 5 columns' && await cellText(t, 1, 2) === '7.0', 'the slice shows a 4×5 table');
  await js(`(() => { const i = ${DV}.host.querySelector('.dv-slice-in'); i.focus(); i.select(); })()`);
  await type('[2, :, :]');
  await press('Enter');
  await until(`${DV}.cellText(0, 0) === '40.0'`, 'second slice', 30000);
  check(true, 'typing another slice shows that part of the array');
  await js(`${DV}.setColored(true)`);
  await until(`${DV}.host.querySelectorAll('.dv-c.num[style*="hsla"]').length === 20`, 'array heatmap', 30000);
  const hues = await js(`[...${DV}.host.querySelectorAll('.dv-c.num')].map((c) => Number(/hsla\\((\\d+)/.exec(c.getAttribute('style'))[1]))`);
  check(hues[0] === 230 && hues[hues.length - 1] === 0, 'array heatmap spans the whole slice, from blue to red');
  await js(`${DV}.setColored(false)`);

  // List of dicts.
  await clickViewLink(t, '#pyconsoleVars .sv-var', 'recs');
  await until(`ide.activeTab()?.title === 'recs'`, 'recs tab');
  await dvReady(t, 'recs page');
  check(await js(`[...${DV}.host.querySelectorAll('.dv-h .dv-hn')].map((n) => n.textContent).join() === 'name,age'`) && await cellText(t, 2, 0) === 'park', 'a list of dicts shows one column per key');
  check(await js(`${DV}.isMissing(1, 1)`), 'None in a list of dicts is shown as missing');

  // polars, when installed.
  if (await js(`ide.installables.find((i) => i.id === 'pip:polars').status().then((s) => s.installed)`)) {
    await consoleRun(t, 'import polars as pl\npframe = pl.DataFrame({"k": [3, 1, 2], "v": ["c", "a", None]})', 'polars frame');
    await until(`document.querySelector('#pyconsoleVars .sv-var[data-name="pframe"] .sv-view-link')`, 'polars variable');
    await clickViewLink(t, '#pyconsoleVars .sv-var', 'pframe');
    await until(`ide.activeTab()?.title === 'pframe'`, 'pframe tab');
    await dvReady(t, 'polars page');
    await js(`${DV}.setSort(0, true)`);
    await until(`${DV}.cellText(0, 0) === '1' && ${DV}.cellText(0, 1) === 'a'`, 'polars sorted', 30000);
    await js(`${DV}.setFilter('k >= 2')`);
    await until(`${DV}.state().info.rows === 2 && ${DV}.cellText(1, 1) !== undefined`, 'polars filtered', 30000);
    check(await js(`${DV}.isMissing(1, 1) || ${DV}.isMissing(0, 1)`), 'a polars DataFrame sorts, filters (SQL expression) and shows nulls');
  }

  // The view follows the console: a change in Python refreshes it.
  await js(`ide.openCustomTab({ id: 'dataview:console:big' })`);
  await until(`ide.activeTab()?.title === 'big'`, 'back to big');
  await dvReady(t, 'big again');
  await consoleRun(t, 'big = big.head(10)', 'shrink big');
  await until(`${DV}.state().info?.rows === 10`, 'data view refreshed after the console changed big', 30000);
  check(await statusText(t) === '10 rows × 3 columns', 'the Data View refreshes after a console statement');

  // Closing a Data View removes its window listener, which would keep the closed view and its rows alive.
  const windowListeners = async (type) => {
    const win = (await t.cdp('Runtime.evaluate', { expression: 'window' })).result.result.objectId;
    return (await t.cdp('DOMDebugger.getEventListeners', { objectId: win })).result.listeners.filter((l) => l.type === type).length;
  };
  const mouseupBefore = await windowListeners('mouseup');
  await js(`ide.closeTabObject(ide.activeTab(), true)`);
  await until(`!ide.tabs.some((x) => x.path === 'dataview:console:big')`, 'big data view closed');
  const mouseupAfter = await windowListeners('mouseup');
  check(mouseupAfter === mouseupBefore - 1, `closing a Data View releases its window listener (${mouseupBefore} -> ${mouseupAfter} mouseup listeners)`);

  // ---------- Plots from the console ----------
  const plotCount = () => js(`ide.plots.list().length`);
  await consoleRun(t, 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 4, 9])', 'console plot');
  await until(`ide.plots.list().length === 1`, 'console plot in Plots', 30000);
  const p1 = await js(`ide.plots.list()[0]`);
  check(p1.source === 'console' && p1.hasSvg && p1.pngBytes > 5000, `a console figure appears in the Plots tool window (${p1.title}, ${p1.pngBytes} bytes)`);
  check(await js(`ide.toolWindows.get('Plots').isVisible() && !!document.querySelector('.sv-plot-img')?.src.startsWith('data:image/png')`), 'the Plots tool window opens and shows the image');
  await consoleRun(t, 'ax.set_title("updated")', 'update console plot');
  await until(`ide.plots.list()[0].id !== ${p1.id}`, 'plot replaced', 30000);
  check(await plotCount() === 1, 'changing the same figure updates its plot instead of adding one');

  // ---------- Plots from Run ----------
  await openFile(t, 'plot_script.py');
  await press('Ctrl+Shift+F10');
  await until(`ide.plots.list().some((p) => p.source === 'plot_script.py')`, 'Run plot', 60000);
  await until(`[...document.querySelectorAll('.console')].some((c) => c.textContent.includes('after show') && /exit code 0/.test(c.textContent))`, 'script finished', 30000);
  check(true, 'plt.show() in a run script sends the figure and returns at once (the script finishes)');
  const runPlot = await js(`ide.plots.list().findIndex((p) => p.source === 'plot_script.py')`);
  check(await js(`ide.plots.list()[${runPlot}].title === 'Run plot' && ide.plots.current() === ${runPlot}`), 'the new plot is selected');
  check(await js(`document.querySelectorAll('.sv-thumb').length`) === await plotCount(), 'every plot has a history thumbnail');
  await click('.sv-zoom-in');
  check(typeof await js(`ide.plots.zoom()`) === 'number', 'Zoom In leaves fit-to-window mode');
  await click('.sv-zoom-actual');
  check(await js(`ide.plots.zoom() === 1 && Math.round(document.querySelector('.sv-plot-img').getBoundingClientRect().width) === Math.round(ide.plots.list()[${runPlot}].width / 2)`), 'Actual Size shows the figure at 100%');
  await click('.sv-zoom-fit');
  check(await js(`ide.plots.zoom() === 'fit'`), 'Fit to Window');
  await click('.sv-thumb[data-index="0"]');
  check(await js(`ide.plots.current() === 0`), 'clicking a thumbnail shows that plot');
  const png = path.join(TMP, 'run-plot.png');
  const svg = path.join(TMP, 'run-plot.svg');
  await js(`ide.plots.save(${runPlot}, 'png', ${JSON.stringify(png)})`);
  await js(`ide.plots.save(${runPlot}, 'svg', ${JSON.stringify(svg)})`);
  check(existsSync(png) && readFileSync(png).subarray(1, 4).toString() === 'PNG', 'Save as PNG writes the image');
  check(existsSync(svg) && /<svg[\s\S]*Run plot/.test(readFileSync(svg, 'utf8')), 'Save as SVG writes the vector figure');
  await shot('dataview-plots.png');

  // ---------- Debugger: Variables, Watches, plots ----------
  await openFile(t, 'debug_frame.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 13, column: 5 }))`);
  await press('Ctrl+F8');
  const plotsBeforeDebug = await plotCount();
  await js(`ide.debugger.debugFile(ide.activeTab().path)`);
  await until(`window.__debugger.state()?.state === 'suspended' && window.__debugger.state().frames[window.__debugger.state().frameIdx]?.line === 13`, 'stopped at line 13', 90000);
  await until(`ide.plots.list().length === ${plotsBeforeDebug + 1}`, 'debugger plot', 30000);
  check(await js(`ide.plots.list().at(-1).title === 'Debug plot' && ide.plots.list().at(-1).source === 'debug_frame.py'`), 'a figure shown under the debugger appears in Plots');
  await until(`document.querySelector('#dbgVars .sv-view-link')`, 'debugger links', 30000);
  const dbgLinks = await js(`Object.fromEntries([...document.querySelectorAll('#dbgVars .dbg-var')].filter((r) => r.querySelector('.dbg-name')).map((r) => [r.querySelector('.dbg-name').textContent, r.querySelector('.sv-view-link')?.textContent || '']))`);
  check(dbgLinks.df === 'View as DataFrame' && dbgLinks.arr === 'View as Array' && dbgLinks.records === 'View as DataFrame', `debugger Variables offer the Data View links (${JSON.stringify(dbgLinks)})`);
  await clickViewLink(t, '#dbgVars .dbg-node > .dbg-var', 'df');
  await until(`!!ide.activeTab()?.dataView && ide.activeTab().path === 'dataview:debugger:df'`, 'debugger data view');
  await dvReady(t, 'debugger df page');
  check(await statusText(t) === '5,000 rows × 3 columns' && await cellText(t, 4999, 0) === undefined && await cellText(t, 1, 2) === 'Busan', 'View as DataFrame from the debugger pages the frame’s DataFrame');
  await js(`${DV}.setSort(0, false)`);
  await until(`${DV}.cellText(0, 0) === '4999'`, 'debugger sort', 30000);
  check(true, 'sorting works while suspended in the debugger');
  await js(`(() => { document.querySelector('#dbgWatchAdd').click(); const i = document.querySelector('#dbgWatchInput'); i.value = "df[df.city == 'Seoul']"; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await until(`document.querySelector('#dbgWatches .sv-view-link')`, 'watch link', 30000);
  await js(`document.querySelector('#dbgWatches .sv-view-link').scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
  await click('#dbgWatches .sv-view-link');
  await until(`ide.activeTab()?.path === "dataview:debugger:df[df.city == 'Seoul']"`, 'watch data view');
  await dvReady(t, 'watch page');
  check(await statusText(t) === '2,500 rows × 3 columns', 'a watch expression opens in the Data View too');
  await press('F9');
  await until(`${DV}.host.querySelector('.dv-msg.warn')`, 'not suspended message', 30000);
  check(true, 'after Resume the Data View says the program is not suspended');
  await until(`!ide.debugger.isActive()`, 'debug session ended', 30000);

  // ---------- Notebook: output links, Jupyter Variables, inline plots ----------
  await openFile(t, 'frames.ipynb');
  await until(`!!ide.activeTab().notebook && ide.activeTab().host.dataset.cells === '3'`, 'notebook view');
  const plotsBeforeNb = await plotCount();
  await js(`ide.activeTab().notebook.runAll()`);
  await until(`ide.activeTab().host.dataset.kernel === 'idle' && ide.activeTab().host.querySelectorAll('.nb-cell')[2].querySelector('.nb-outputs img')`, 'notebook ran', 120000);
  const nbLinks = await js(`[...ide.activeTab().host.querySelectorAll('.nb-cell')].map((c) => c.querySelector('.sv-view-link')?.textContent || '')`);
  check(nbLinks[0] === 'View as DataFrame' && nbLinks[1] === 'View as Array' && !nbLinks[2], `notebook results offer Data View links (${nbLinks.join(' | ')})`);
  check(await plotCount() === plotsBeforeNb && await js(`!!ide.activeTab().host.querySelector('.nb-outputs img.nb-image')`), 'notebook plots stay inline and do not go to the Plots window');
  const nbTab = await js(`ide.activeTab().path`);
  await js(`document.querySelector('.custom-tab:not(.hidden) .nb-cell .sv-view-link').scrollIntoView({ block: 'center' })`);
  await click('.custom-tab:not(.hidden) .nb-cell .sv-view-link');
  await until(`!!ide.activeTab()?.dataView && ide.activeTab().title.startsWith('Out[1]')`, 'notebook data view');
  await dvReady(t, 'notebook frame page');
  check(await statusText(t) === '10 rows × 2 columns' && await cellText(t, 3, 1) === '0.75', 'View as DataFrame on a notebook result pages Out[n] from the kernel');
  await js(`ide.openCustomTab({ id: ${JSON.stringify(nbTab)} })`);
  await until(`!!ide.activeTab()?.notebook`, 'notebook front');
  await js(`ide.toolWindows.get('JupyterVariables').show()`);
  await until(`document.querySelector('.sv-jv .sv-var[data-name="frame"] .sv-view-link') && document.querySelector('.sv-jv .sv-var[data-name="grid"] .sv-view-link')`, 'jupyter variables', 30000);
  check(await js(`!document.querySelector('.sv-jv .sv-var[data-name="In"]') && !document.querySelector('.sv-jv .sv-var[data-name="np"]')`), 'Jupyter Variables lists the notebook’s variables without IPython internals or modules');
  await clickViewLink(t, '.sv-jv .sv-var', 'grid');
  await until(`ide.activeTab()?.title === 'grid'`, 'grid data view');
  await dvReady(t, 'grid page');
  check(await statusText(t) === '3 rows × 4 columns' && await cellText(t, 2, 3) === '11', 'View as Array from Jupyter Variables');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
  await shot('dataview-error.png').catch(() => {});
}
t.close();

// ---------- Korean session ----------
const k = await launch({ fixture: 'dataview', port: 9721, name: 'dataview-ko', lang: 'ko-KR' });
try {
  await k.until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(k, VENV_PY);
  await k.js(`ide.toolWindows.get('PythonConsole').show()`);
  await k.until(`ide.pyconsole.isRunning() && document.querySelector('#pyconsolePrompt').textContent === '>>> '`, 'console prompt', 60000);
  await consoleRun(k, 'import numpy as np, pandas as pd, matplotlib.pyplot as plt\ndf = pd.DataFrame({"a": [1.5, None, 3.0], "b": ["x", "y", None]})\narr = np.zeros((2, 2, 2))\nplt.plot([1, 2])', 'ko console');
  await k.until(`document.querySelector('#pyconsoleVars .sv-var[data-name="df"] .sv-view-link')`, 'ko variables', 30000);
  k.check(await k.js(`document.querySelector('#pyconsoleVars .sv-var[data-name="df"] .sv-view-link').textContent`) === 'DataFrame으로 보기', 'View as DataFrame is translated');
  k.check(await k.js(`document.querySelector('#pyconsoleVars .sv-var[data-name="arr"] .sv-view-link').textContent`) === '배열로 보기', 'View as Array is translated');
  await clickViewLink(k, '#pyconsoleVars .sv-var', 'arr');
  await k.until(`!!ide.activeTab()?.dataView`, 'ko data view');
  await dvReady(k, 'ko page');
  k.check(await statusText(k) === '2행 × 2열', `status is Korean (${await statusText(k)})`);
  k.check(await k.js(`${DV}.host.querySelector('.dv-slice .dv-label').textContent === '슬라이스' && ${DV}.host.querySelector('.dv-colored').textContent === '색상 표시'`), 'Data View controls are Korean');
  await k.js(`${DV}.setSlice('[0, 0, 0, 0]')`);
  await k.until(`${DV}.host.querySelector('.dv-msg.error')`, 'slice error', 30000);
  await k.js(`${DV}.setSlice('[0, :, :]')`);
  await clickViewLink(k, '#pyconsoleVars .sv-var', 'df');
  await k.until(`ide.activeTab()?.title === 'df'`, 'ko df');
  await dvReady(k, 'ko df page');
  await k.until(`ide.plots.list().length === 1 && ide.toolWindows.get('Plots').isVisible()`, 'ko plot', 30000);
  await k.js(`ide.toolWindows.get('PythonConsole').show()`);
  const leaks = [
    ...await englishLeaks(k, '.custom-tab:not(.hidden).dv-host'),
    ...await englishLeaks(k, '#pyconsoleVars'),
    ...await englishLeaks(k, '.sv-plots'),
    ...await englishLeaks(k, '#bottomActions'),
  ];
  k.check(!leaks.length, `no English in the Data View, console variables, Plots or their actions${leaks.length ? `: ${JSON.stringify(leaks)}` : ''}`);
  await k.js(`ide.openFile(ide.util.joinPath(ide.root, 'frames.ipynb'))`);
  await k.until(`!!ide.activeTab()?.notebook`, 'ko notebook');
  await k.js(`ide.toolWindows.get('JupyterVariables').show()`);
  await k.until(`document.querySelector('.sv-jv .sv-empty')`, 'ko jupyter variables');
  const jvLeaks = await englishLeaks(k, '.sv-jv');
  k.check(!jvLeaks.length && await k.js(`ide.toolWindows.get('JupyterVariables').tab.textContent === 'Jupyter 변수' && ide.toolWindows.get('Plots').button.title === '플롯'`),
    `Jupyter Variables and the Plots stripe button are Korean${jvLeaks.length ? `: ${JSON.stringify(jvLeaks)}` : ''}`);
  await k.js(`ide.openSettings('python-plots')`);
  await k.until(`document.querySelector('#svShowPlots')`, 'settings page');
  const settingsLeaks = await englishLeaks(k, '.dialog');
  k.check(!settingsLeaks.length && await k.js(`document.querySelector('#svShowPlots').checked`), `Settings › Python Plots is Korean and on by default${settingsLeaks.length ? `: ${JSON.stringify(settingsLeaks)}` : ''}`);
  await k.press('Escape');
  const mine = new Set([
    ...[...readFileSync(new URL('../renderer/features/sciview/index.js', import.meta.url), 'utf8').matchAll(/tr\('((?:\\'|[^'])+)'/g)].map((m) => m[1].replace(/\\'/g, "'")),
    'Show Variables', 'Hide Variables', 'The Python Console is not running.',
  ]);
  const ko = JSON.parse(readFileSync(new URL('../renderer/features/sciview/locales/ko.json', import.meta.url), 'utf8'));
  const untranslated = [...mine].filter((s) => !(s in ko) && !['Show Variables', 'Hide Variables', 'The Python Console is not running.'].includes(s));
  k.check(!untranslated.length, `every Data View and Plots string has a Korean entry${untranslated.length ? `: ${untranslated.join(' | ')}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => mine.has(s));
  k.check(!missing.length, `no missing translations at runtime${missing.length ? `: ${missing.join(' | ')}` : ''}`);
  await k.shot('dataview-ko.png');
} catch (err) {
  k.check(false, `unexpected error (Korean session): ${err.message}`);
  await k.shot('dataview-ko-error.png').catch(() => {});
}
k.close();

const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
// Exceptions thrown from other plugins' own code (features this suite does not exercise) are listed, not counted.
const MINE = /renderer[\\/](core|features[\\/](sciview|pyconsole|debugger|notebook|installer|settings|run))[\\/]/;
const foreign = (e) => { const at = /\n\s+at .*?(renderer[\\/][^\s)]+)/.exec(e); return !!at && !MINE.test(at[1]); };
const raised = [...t.consoleErrors, ...k.consoleErrors];
const others = raised.filter(foreign);
if (others.length) console.log(`exceptions from other plugins (not counted):\n  ${others.map((e) => e.split('\n').slice(0, 2).join(' ')).join('\n  ')}`);
const errors = raised.filter((e) => !foreign(e));
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
