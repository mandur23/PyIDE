// Spell checker (Typo inspection): typos in comments and defined names with suggestions and a working quick fix,
// zero markers on correct code, Korean comments and skipped spans, Markdown, the project and user dictionaries
// across a reload, the Settings switch, the commit message box, typing without blocking, and the Korean UI.
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const ctx = await launch({ fixture: 'spellcheck', port: 9980, name: 'spellcheck' });
const { js, until, press, type, check, sleep } = ctx;

const model = 'ide.activeTab().model';
const typos = `ide.spellcheck.markers(${model}).map((m) => m.message.match(/'(.*)'/)[1])`;
// Waits until the lines in view were checked (or the given condition holds) and the worker answered.
const settle = async (label, cond = 'true') => {
  await until(`ide.spellcheck.checkedLines(${model}) > 0 && (${cond})`, label);
  await js('ide.spellcheck.idle()');
  await sleep(400);
};
const caretOn = (line, col) => js(`(ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.focus(), true)`);
// Alt+Enter, then picks the quick fix whose title is given with the arrow keys (the list only draws rows in view).
// Monaco restarts an open Alt+Enter request as an automatic one when a model's markers change, which Pyright's
// diagnostics can do while the lsp provider waits for its server; Alt+Enter is then pressed again.
async function quickFix(title) {
  const rows = `[...document.querySelectorAll('.action-widget .monaco-list-row')]`;
  await js('ide.lsp?.ready()');
  for (let attempt = 0; ; attempt++) {
    await press('Alt+Enter');
    try {
      await until(`${rows}.length > 0`, 'quick fix menu', 5000);
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await press('Escape');
    }
  }
  for (let i = 0; i < 20; i++) {
    if (await js(`${rows}.find((r) => r.classList.contains('focused'))?.textContent.includes(${JSON.stringify(title)})`)) {
      await press('Enter');
      await until(`!document.querySelector('.action-widget .monaco-list-row')`, 'quick fix menu closes');
      return;
    }
    await press('ArrowDown');
  }
  throw new Error(`no quick fix "${title}" in ${JSON.stringify(await js(`${rows}.map((r) => r.textContent)`))}`);
}

// ---------- typos and suggestions ----------
await openFile(ctx, 'typo.py');
await settle('typo.py checked', `${typos}.includes('nmae')`);
let found = await js(typos);
check(found.includes('mispeled') && found.includes('coment'), `"# this is a mispeled coment" flags both words (${found})`);
check(found.includes('nmae'), `def get_usr_nmae() flags "nmae" (${found})`);
check(!found.includes('this') && !found.includes('get'), 'correct words are not flagged');
const markers = await js(`ide.spellcheck.markers(${model}).map((m) => ({ line: m.startLineNumber, col: m.startColumn, end: m.endColumn, severity: m.severity, msg: m.message }))`);
const nmae = markers.find((m) => m.msg.includes("'nmae'"));
check(nmae && nmae.line === 4 && nmae.col === 13 && nmae.end === 17, `the "nmae" marker covers just that part of the name (${JSON.stringify(nmae)})`);
check(markers.every((m) => m.severity === 1) && markers[0].msg === "Typo: In word 'mispeled'", `typos are hint markers with PyCharm's message (${markers[0]?.msg})`);
await until(`document.querySelector('.monaco-editor .squiggly-hint')`, 'typo decoration drawn');
const wave = await js(`getComputedStyle(document.querySelector('.monaco-editor .squiggly-hint')).backgroundImage`);
check(wave.includes('6a9f62') && wave.includes('svg'), 'typos are drawn as a green wavy underline');

const sugg = await js(`(async () => ({ a: await ide.spellcheck.suggest('mispeled'), b: await ide.spellcheck.suggest('coment'), c: await ide.spellcheck.suggest('nmae') }))()`);
check(sugg.a[0] === 'misspelled' && sugg.b[0] === 'comment' && sugg.c[0] === 'name', `suggestions put misspelled / comment / name first (${sugg.a[0]}, ${sugg.b[0]}, ${sugg.c[0]})`);

await caretOn(1, 14);
await quickFix("Change to 'misspelled'");
check(await js(`${model}.getLineContent(1)`) === '# this is a misspelled coment', `Alt+Enter › Change to 'misspelled' rewrites the word (${await js(`${model}.getLineContent(1)`)})`);
await settle('recheck after fix', `!${typos}.includes('mispeled')`);
found = await js(typos);
check(!found.includes('misspelled') && found.includes('coment'), `the fixed word is no longer flagged, the other still is (${found})`);
await press('Ctrl+Z');
await settle('undo restores the typo', `${typos}.includes('mispeled')`);
check(await js(`${model}.getLineContent(1)`) === '# this is a mispeled coment', 'the fix is one undo step');

// ---------- correct code, Korean, skipped spans ----------
await openFile(ctx, 'clean.py');
await settle('clean.py checked', `ide.spellcheck.checkedLines(${model}) >= 25`);
found = await js(typos);
check(found.length === 0, `correct code, Korean comments, URLs, e-mails, hex, paths, ALLCAPS and programming words give zero markers (${found})`);
check(await js(`ide.spellcheck.checkedLines(${model})`) >= 25, 'every line of clean.py was checked');

await openFile(ctx, 'notes.md');
await settle('notes.md checked', `${typos}.length > 0`);
found = await js(typos);
check(found.length === 1 && found[0] === 'tpyo', `Markdown: prose typos are flagged, code blocks, inline code and link targets are not (${found})`);
// The Markdown viewer embeds its own editor next to the preview.
await js(`(() => { const ed = ide.monaco.editor.getEditors().find((e) => e.getModel() === ${model}); ed.setPosition({ lineNumber: 3, column: 23 }); ed.focus(); return true; })()`);
await quickFix("Change to 'typo'");
check((await js(`${model}.getLineContent(3)`)).includes('has a typo in it'), 'Alt+Enter works in Markdown too');

// ---------- dictionaries ----------
await openFile(ctx, 'typo.py');
await settle('typo.py again', `${typos}.includes('nmae')`);
await caretOn(4, 14);
await quickFix("Save 'nmae' to project dictionary");
await until(`!${typos}.includes('nmae')`, 'nmae marker removed');
check(true, 'Save to project dictionary removes the marker');
const dictFile = path.join(ctx.project, '.pyide', 'dictionary.txt');
check(existsSync(dictFile) && readFileSync(dictFile, 'utf8').split(/\r?\n/).includes('nmae'), 'the word is written to .pyide/dictionary.txt');
await caretOn(1, 23);
await quickFix("Save 'coment' to user dictionary");
await until(`!${typos}.includes('coment')`, 'coment marker removed');
check((await js(`ide.settings.get('spellcheck.userWords')`)).includes('coment'), 'Save to user dictionary removes the marker and stores the word in the settings');

await js('ide.settings.flush()');
await ctx.cdp('Page.reload');
await until('window.__ideReady === true', 'IDE ready after reload', 30000);
await openFile(ctx, 'typo.py');
await settle('typo.py after reload', `${typos}.includes('mispeled')`);
found = await js(typos);
check(!found.includes('nmae') && !found.includes('coment') && found.includes('mispeled'), `both dictionaries persist after a reload (${found})`);

// ---------- Settings ----------
await js(`ide.openSettings('spelling')`);
await until(`document.querySelector('.settings-page[data-page="spelling"] input[data-key="spellcheck.enabled"]')`, 'Spelling page');
const page = await js(`({ on: document.querySelector('input[data-key="spellcheck.enabled"]').checked, user: document.querySelector('#spellUserWords').value, project: document.querySelector('#spellProjectWords').value })`);
check(page.on && page.user === 'coment' && page.project === 'nmae', `the Spelling page shows the switch and both dictionaries (${JSON.stringify(page)})`);
await ctx.click('input[data-key="spellcheck.enabled"]');
await ctx.click('#settingsOk');
await until(`${typos}.length === 0`, 'markers cleared');
check(!(await js('ide.spellcheck.enabled()')), 'turning the checker off clears the markers');
await js(`ide.settings.set('spellcheck.enabled', true)`);
await settle('back on', `${typos}.includes('mispeled')`);
check((await js(typos)).includes('mispeled'), 'turning it back on checks again');

// Editing the project dictionary in Settings rewrites the file.
await js(`ide.openSettings('spelling')`);
await until(`document.querySelector('#spellProjectWords')`, 'Spelling page again');
await js(`(() => { const a = document.querySelector('#spellProjectWords'); a.value = 'nmae\\nmispeled'; a.dispatchEvent(new Event('input')); return true; })()`);
await ctx.click('#settingsOk');
await until(`!${typos}.includes('mispeled')`, 'mispeled accepted through Settings');
check(readFileSync(dictFile, 'utf8').split(/\r?\n/).includes('mispeled'), 'words added on the Settings page go to the project dictionary file');

// ---------- commit message ----------
execSync('git init -q', { cwd: ctx.project });
await js('ide.vcs.refresh()');
await press('Alt+0');
await until(`document.querySelector('textarea.vcs-msg') && document.querySelector('textarea.vcs-msg').offsetParent`, 'commit message box');
await js(`document.querySelector('textarea.vcs-msg').focus()`);
await type('Fix the wrnog handling of settings');
await until(`ide.spellcheck.commitTypos().includes('wrnog')`, 'commit message checked');
check(await js(`document.querySelector('.spell-overlay .spell-typo')?.textContent === 'wrnog'`), 'a typo in the commit message gets a wavy underline');
await js(`(() => { const t = document.querySelector('textarea.vcs-msg'); t.setSelectionRange(10, 10); return true; })()`);
await press('Alt+Enter');
await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((m) => m.textContent.includes("Change to 'wrong'"))`, 'commit message actions');
const item = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find((m) => m.textContent.includes("Change to 'wrong'")).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) await ctx.cdp('Input.dispatchMouseEvent', { type: t, x: item.x, y: item.y, button: 'left', clickCount: 1 });
await until(`document.querySelector('textarea.vcs-msg').value.includes('wrong')`, 'commit message fixed').catch(() => {});
const fixed = await js(`document.querySelector('textarea.vcs-msg').value`);
check(fixed === 'Fix the wrong handling of settings', `Alt+Enter › Change to fixes the commit message (${fixed})`);
await until(`!ide.spellcheck.commitTypos().length && !document.querySelector('.spell-overlay .spell-typo')`, 'commit typo gone');
check(true, 'the fixed commit message has no underline left');
await press('Alt+0');

// ---------- typing does not block ----------
await openFile(ctx, 'typing.py');
await settle('typing.py checked');
await js(`(() => { const m = ${model}; ide.editor.setPosition({ lineNumber: 2, column: 1 }); ide.editor.focus();
  window.__lag = { max: 0, long: [] }; let last = performance.now();
  window.__lagTimer = setInterval(() => { const now = performance.now(); window.__lag.max = Math.max(window.__lag.max, now - last - 10); last = now; }, 10);
  window.__lagObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lag.long.push(Math.round(e.duration)); });
  window.__lagObs.observe({ entryTypes: ['longtask'] }); return true; })()`);
const before = await js('ide.spellcheck.stats()');
const text = '# The quick brown fox jumps over the lazy dog while the wizrd checks evry sentense for misteaks; nothing here should block the keyboard at all, not even a littel bit, during this tset of twohundred chars.';
await type('\n');
// Steady keystrokes with a short pause every 40 characters, so checking passes run between bursts of typing.
const t0 = Date.now();
for (const [i, ch] of [...text.slice(0, 200)].entries()) {
  await ctx.cdp('Input.insertText', { text: ch });
  await sleep(i % 40 === 39 ? 450 : 15);
}
const typedMs = Date.now() - t0;
await settle('typed text checked', `${typos}.includes('wizrd')`);
const lag = await js(`(() => { clearInterval(window.__lagTimer); window.__lagObs.disconnect(); return window.__lag; })()`);
const after = await js('ide.spellcheck.stats()');
found = await js(typos);
check(['wizrd', 'evry', 'sentense', 'misteaks', 'littel', 'tset'].every((w) => found.includes(w)), `the typed comment is checked (${found})`);
console.log(`  typing 200 chars: ${typedMs} ms, longest spell slice ${after.maxSliceMs.toFixed(2)} ms, ${after.passes - before.passes} passes, ${after.requests - before.requests} worker requests, timer lag max ${Math.round(lag.max)} ms, long tasks [${lag.long.join(', ')}]`);
check(after.maxSliceMs < 16, `spell checking never holds the main thread for a frame (${after.maxSliceMs.toFixed(2)} ms)`);
check(lag.max < 100 && Math.max(0, ...lag.long) < 100, `typing 200 characters does not block the main thread (timer lag ${Math.round(lag.max)} ms, long tasks [${lag.long.join(', ')}])`);

ctx.close();

// ---------- Korean UI ----------
const ko = await launch({ fixture: 'spellcheck', port: 9981, name: 'spellcheck-ko', lang: 'ko-KR' });
await openFile(ko, 'typo.py');
await ko.until(`ide.spellcheck.markers(${model}).length >= 3`, 'Korean typos');
const msg = await ko.js(`ide.spellcheck.markers(${model})[0].message`);
check(msg === "오타: 단어 'mispeled'", `the marker message is Korean (${msg})`);
await ko.js(`ide.openSettings('spelling')`);
await ko.until(`document.querySelector('.settings-page[data-page="spelling"]')`, 'Korean Spelling page');
check(await ko.js(`document.querySelector('.settings-page[data-page="spelling"]').textContent.includes('맞춤법') && document.querySelector('.settings-page[data-page="spelling"]').textContent.includes('사용자 사전')`), 'the Spelling page is Korean');
ko.results.unshift(...ctx.results);
ko.consoleErrors.unshift(...ctx.consoleErrors);
ko.finish();
