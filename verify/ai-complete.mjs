// AI Completion plugin: ghost text while typing, Tab / Ctrl+Right / Esc, typing through a suggestion, stale replies,
// the suggest widget and comments, Ctrl+Alt+\, toggling, settings across a restart, the Install Manager, and Korean UI.
// Uses the deterministic fake model unless AI_COMPLETE_REAL=1, which runs the installed Qwen2.5-Coder on a fixture and
// reports latency (p50/p90) for real completions.
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.env.AI_COMPLETE_REAL === '1';
process.env.PYIDE_AI_COMPLETE_BACKEND = REAL ? 'real' : 'fake';
const require = createRequire(import.meta.url);
const { plan, trimCompletion } = require('../main/ai/complete-text.js');
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// The suggestion as Monaco draws it: the inline part on the caret's line plus any extra lines below it.
const GHOST = `(() => {
  const root = ide.editor?.getDomNode();
  if (!root) return '';
  const inline = [...root.querySelectorAll('.ghost-text-decoration')].map((n) => n.textContent).join('');
  const extra = [...new Set([...root.querySelectorAll('.ghost-text')].map((n) => n.closest('.view-line') || n))].map((n) => n.textContent);
  // Monaco draws spaces as no-break spaces.
  return [inline, ...extra].join('\\n').replace(/\\u00a0/g, ' ').replace(/\\n+$/, '');
})()`;
const ghost = (t) => t.js(GHOST);
const line = (t) => t.js(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber)`);
// Types line by line: Monaco applies auto-indent to a typed newline, not to one inside a longer insertion.
const typeCode = async (t, text) => {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) await t.type(parts[i]);
    if (i < parts.length - 1) await t.type('\n');
  }
};
const serverStats = (t) => t.js(`ide.api.invoke('ai-complete:stats')`);
// A fresh empty line at the end of the file with the caret on it.
const freshLine = (t) => t.js(`(() => {
  const m = ide.editor.getModel();
  const n = m.getLineCount();
  m.pushEditOperations([], [{ range: new ide.monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n)), text: '\\n\\n' }], () => null);
  ide.editor.setPosition({ lineNumber: m.getLineCount(), column: 1 });
  ide.editor.focus();
  return true;
})()`);

// ---------- trimming rules (main/ai/complete-text.js) ----------
{
  const trim = (raw, prefix, suffix = '', multiline = true) => trimCompletion(raw, { prefix, suffix, ...plan({ prefix, suffix, multiline }) }).text;
  check(trim('return a + b\n\n\ndef other():\n    pass', 'def add(a, b):\n    ') === 'return a + b', 'a statement-start suggestion ends at the next definition');
  check(trim('\n    if n < 2:\n        return n\n    return n * f(n - 1)\n\nprint(1)', 'def f(n):') === '\n    if n < 2:\n        return n\n    return n * f(n - 1)', 'a block suggestion keeps the body and stops at the dedent');
  check(trim('"hi")', 'print(', ')') === '"hi"', 'an auto-closed bracket after the caret is not suggested twice');
  check(trim('x)', 'f(g(', ')') === 'x)', 'a bracket the line still needs is kept');
  check(trim('   \n  ', 'x = ') === '', 'whitespace alone is never suggested');
  check(trim('value\n    more', 'x = ', '', false) === 'value', 'single-line mode keeps one line');
  check(trim('a, b)\n    return 1', 'call(', ')\n    return 1') === 'a, b', 'text that already follows the caret is dropped');
  check(plan({ prefix: 'x = foo(', suffix: 'bar)', multiline: true }).indent === null, 'text after the caret on its line means a single-line suggestion');

  // The model server stops generating where trimming will cut (complete_server.py finished() vs complete-text.js).
  const cases = [
    ['def f(n):', '\n    if n < 2:\n        return n\n    return f(n - 1)\n\nprint(f(3))\n'],
    ['def add(a, b):\n    ', 'return a + b\n\n\ndef other():\n    pass\n'],
    ['', 'def foo():\n    x = 1\n\n    y = 2\n\n\ndef bar():\n    pass\n'],
    ['x = ', 'value\nmore\n'],
    ['class A:\n    def m(self):', '\n        return 1\n\n    def n(self):\n        return 2\n'],
  ].map(([prefix, raw]) => ({ raw, ...plan({ prefix, suffix: '', multiline: !prefix.startsWith('x = ') }), js: trimCompletion(raw, { prefix, suffix: '', ...plan({ prefix, suffix: '', multiline: !prefix.startsWith('x = ') }) }).text }));
  const py = spawnSync('py', ['-3', '-I', '-c', [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(path.join(APP_DIR, 'main', 'ai', 'complete_server.py'))})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'out = []',
    'for c in json.load(sys.stdin):',
    '    e = m.finished(c["raw"], c["stop"], c["indent"], c["blankIndent"])',
    '    out.append((c["raw"] if e is None else c["raw"][:e]).rstrip())',
    'print(json.dumps(out))',
  ].join('\n')], { input: JSON.stringify(cases), encoding: 'utf8' });
  if (py.status === 0) {
    const cut = JSON.parse(py.stdout);
    check(cases.every((c, i) => cut[i] === c.js), `the model server stops where trimming cuts${cases.some((c, i) => cut[i] !== c.js) ? ` ${JSON.stringify(cut)} vs ${JSON.stringify(cases.map((c) => c.js))}` : ''}`);
  } else console.log(`SKIP server stop rule (no Python launcher: ${py.stderr || py.error})`);
}

let a;
let b;
try {
  a = await launch({ fixture: 'ai-complete', port: 9640, name: 'ai-complete' });
  await openFile(a, REAL ? 'stats.py' : 'main.py');
  await a.until(`ide.aiComplete.mode() === 'on'`, 'completion ready');
  // Monaco loads Python's tokenizer and its indentation rules together, lazily; auto-indent needs the rules.
  await a.until(`ide.monaco.editor.tokenize('def x', 'python')[0][0].type.startsWith('keyword')`, 'Python language support loaded');
  // Pyright's completion list popping up mid-typing would take the typed newlines; Ctrl+Space still opens it.
  await a.js(`(ide.editor.updateOptions({ quickSuggestions: false, suggestOnTriggerCharacters: false }), true)`);
  check(await a.js(`document.querySelector('#aiCompleteStatus').textContent.includes('AI Completion')`), 'the status bar shows AI Completion');

  if (REAL) {
    // ---------- real model ----------
    await a.js(`(() => { const m = ide.editor.getModel(); ide.editor.setPosition({ lineNumber: m.getLineCount(), column: m.getLineMaxColumn(m.getLineCount()) }); ide.editor.focus(); return true; })()`);
    await a.type('\n');
    await a.until(`${GHOST}.trim().length > 0`, 'first real completion', 120000);
    const body = await ghost(a);
    console.log(`clamp body suggestion: ${JSON.stringify(body)}`);
    check(/return|min\(|max\(/.test(body) && /low/.test(body) && /high/.test(body), 'the model completes clamp() from its docstring using low and high');
    await a.press('Tab');
    await a.until(`!${GHOST}`, 'accepted');
    check((await a.js(`ide.editor.getModel().getValue()`)).includes(body.trim().split('\n')[0].trim()), 'Tab inserts the real suggestion');

    await freshLine(a);
    await typeCode(a, 'def ratio(a, b):\n');
    await a.type('return (a - b) / (a');
    await a.until(`${GHOST}.length > 0`, 'expression completion', 60000);
    const expr = await ghost(a);
    await a.press('Tab');
    await a.sleep(300);
    const done = await line(a);
    console.log(`half-written expression suggestion: ${JSON.stringify(expr)} -> ${JSON.stringify(done)}`);
    check(!expr.includes('\n') && done.split('(').length === done.split(')').length && done.length > '    return (a - b) / (a)'.length,
      'the accepted suggestion closes the half-written expression on its line');

    // Latency of real completions as the user types: one request per keystroke along a function, each after a pause.
    const steps = 'def moving_average(values, window):\n    """Average of each run of window values."""\n    out = []\n    for i in range(len(values) - window + 1):\n        out.append(sum(values[i:i + window]) / window)\n    return out\n';
    const ms = await a.js(`(async () => {
      const text = ${JSON.stringify(steps)};
      const head = ide.editor.getModel().getValue() + '\\n\\n';
      const out = [];
      for (let i = 8; i < text.length; i += 7) {
        const r = await ide.api.invoke('ai-complete:complete', { id: 'bench' + i, prefix: head + text.slice(0, i), suffix: '\\n', path: 'stats.py', language: 'python', context: [], multiline: true, model: 'qwen2.5-coder-0.5b', repo: 'project' });
        out.push(r.ms);
      }
      return out;
    })()`);
    const sorted = [...ms].sort((x, y) => x - y);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    console.log(`real completion latency over ${ms.length} requests: p50 ${pct(50)} ms, p90 ${pct(90)} ms, max ${sorted[sorted.length - 1]} ms`);
    const ui = await serverStats(a);
    console.log(`completions shown while typing in the editor: ${JSON.stringify(ui.latencies.slice(0, 5))} ms`);
    check(pct(50) < 1500, `real completions are interactive (p50 ${pct(50)} ms)`);
    check(a.consoleErrors.length === 0, 'no renderer exceptions');
    a.close();
  } else {
    await a.js(`(() => { const m = ide.editor.getModel(); ide.editor.setPosition({ lineNumber: m.getLineCount(), column: 1 }); ide.editor.focus(); return true; })()`);

    // ---------- ghost text, Tab, undo ----------
    await typeCode(a, 'def greet(name):\n');
    await a.until(`${GHOST} === 'return f"Hello, {name}!"'`, 'ghost text after a pause');
    check(true, 'ghost text appears after a pause in a Python file');
    await a.shot('ghost.png');
    await a.press('Tab');
    await a.until(`!${GHOST}`, 'ghost accepted');
    await a.sleep(500);
    check(await line(a) === '    return f"Hello, {name}!"' && (await a.js(`ide.editor.getModel().getValue().split('Hello').length - 1`)) === 1, 'Tab inserts the suggestion exactly once');
    await a.press('Ctrl+Z');
    check(await line(a) === '    ', 'undo restores the line');

    // ---------- Ctrl+Right, Esc ----------
    await a.type('r');
    await a.until(`${GHOST}.startsWith('eturn')`, 'ghost back after typing on');
    await a.press('Ctrl+ArrowRight');
    await a.sleep(200);
    const afterWord = await line(a);
    check(afterWord.trim() === 'return' && (await ghost(a)).trim().startsWith('f"Hello'), `Ctrl+Right accepts one word (${JSON.stringify(afterWord)})`);
    const before = (await serverStats(a)).requests;
    await a.press('Escape');
    await a.sleep(600);
    check(!(await ghost(a)) && (await line(a)).trim() === 'return' && (await serverStats(a)).requests === before, 'Esc dismisses without asking the model again');
    // Typing the next character of the dismissed suggestion does not bring it back.
    await a.type(afterWord.endsWith(' ') ? 'f' : ' ');
    await a.sleep(600);
    check(!(await ghost(a)), 'a dismissed suggestion stays dismissed while typing on');

    // ---------- typing through a suggestion ----------
    await freshLine(a);
    await typeCode(a, 'def area(w, h):\n');
    await a.until(`${GHOST} === 'return w * h'`, 'area ghost');
    const asked = (await serverStats(a)).requests;
    await a.type('r');
    const kept = await ghost(a);
    await a.type('e');
    await a.sleep(500);
    check(kept === 'eturn w * h' && await ghost(a) === 'turn w * h' && (await serverStats(a)).requests === asked,
      'typing characters that match the suggestion keeps it without a new request');
    await a.type('x');
    await a.until(`!${GHOST}`, 'mismatch hides the ghost', 3000);
    await a.until(`ide.api.invoke('ai-complete:stats').then((s) => s.requests === ${asked + 1})`, 'new request after a mismatch', 3000);
    check(true, 'a mismatching character cancels the suggestion and asks again');

    // ---------- stale replies ----------
    await a.js(`ide.api.invoke('ai-complete:testConfig', { delay: 900 })`);
    await a.js(`(() => {
      window.__ghosts = [];
      window.__ghostWatch = new MutationObserver(() => { const g = ${GHOST}; if (g) window.__ghosts.push(g); });
      window.__ghostWatch.observe(ide.editor.getDomNode(), { subtree: true, childList: true, characterData: true });
      return true;
    })()`);
    await freshLine(a);
    const cancelledBefore = (await serverStats(a)).cancelled;
    await a.type('print("hello');
    await a.sleep(450);
    await a.type(' there');
    await a.sleep(1800);
    check(!(await a.js(`window.__ghosts.some((g) => g.includes('world'))`)) && (await serverStats(a)).cancelled > cancelledBefore,
      'a reply for text the user has typed past is dropped (and the request cancelled)');
    await a.js(`(window.__ghostWatch.disconnect(), ide.api.invoke('ai-complete:testConfig', { delay: 0 }))`);

    // ---------- multi-line block, auto-closed brackets ----------
    await freshLine(a);
    await typeCode(a, 'total = 0\nfor i in range(3):');
    await a.until(`${GHOST}.includes('print(total)')`, 'block ghost');
    check(await ghost(a) === '\n    total += i\n    print(total)', 'a multi-line suggestion covers the block and stops at its end');
    await a.press('Tab');
    await a.sleep(300);
    const doc = await a.js(`ide.editor.getModel().getValue()`);
    check(doc.includes('for i in range(3):\n    total += i\n    print(total)') && !doc.includes('done'), 'Tab inserts the whole block');
    await freshLine(a);
    await a.js(`(() => { const p = ide.editor.getPosition(); ide.editor.executeEdits('test', [{ range: new ide.monaco.Range(p.lineNumber, 1, p.lineNumber, 1), text: 'def half(x):\\n' }]); ide.editor.setPosition({ lineNumber: p.lineNumber + 1, column: 1 }); return true; })()`);
    await a.type('\n');
    await a.until(`${GHOST} === '    return x / 2'`, 'indented ghost at column 1');
    await a.press('Tab');
    await a.sleep(300);
    check(await line(a) === '    return x / 2', 'Tab accepts a suggestion that starts with indentation instead of indenting');
    await freshLine(a);
    // A single typed bracket is auto-closed, as when the user types it.
    await a.type('total = add');
    await a.type('(');
    await a.until(`${GHOST} === '1, 2'`, 'call ghost');
    await a.press('Tab');
    await a.sleep(300);
    check(await line(a) === 'total = add(1, 2)', 'a closing bracket after the caret is not doubled');
    await freshLine(a);
    await a.type('ratio = (a - b) / ');
    await a.type('(');
    await a.type('a');
    await a.until(`${GHOST}.includes('else')`, 'ghost around the auto-closed bracket');
    await a.press('Tab');
    await a.sleep(300);
    check(await line(a) === 'ratio = (a - b) / (a + b) if a + b else 0', 'a suggestion that closes the bracket itself replaces the auto-closed one');
    await freshLine(a);
    await a.type('result = ');
    await a.until(`${GHOST} === 'compute_total(items, tax=0.1)'`, 'call ghost to type through');
    await a.type('compute_total');
    await a.type('(');
    await a.sleep(500);
    check(await line(a) === 'result = compute_total()' && !(await ghost(a)).endsWith(')'),
      'typing an auto-closed bracket through a suggestion does not offer a second closing bracket');

    // A very long line just above the caret: the prompt still ends at the caret.
    await freshLine(a);
    await a.js(`(() => {
      const m = ide.editor.getModel();
      const n = ide.editor.getPosition().lineNumber;
      let long = n;
      while ((long + 2) % ${16}) long++;
      m.pushEditOperations([], [{ range: new ide.monaco.Range(n, 1, n, 1), text: '\\n'.repeat(long - n) + '# ' + 'x'.repeat(3500) + '\\n' }], () => null);
      ide.editor.setPosition({ lineNumber: long + 1, column: 1 });
      return true;
    })()`);
    await typeCode(a, 'def area(w, h):\n');
    await a.until(`${GHOST} === 'return w * h'`, 'ghost below a long line');
    check(true, 'a suggestion still appears right below a very long line');

    // ---------- suggest widget, comments, Alt+\ ----------
    await a.js(`(ide.settings.set('aiComplete.delay', 700), true)`);
    await freshLine(a);
    await typeCode(a, 'def area(w, h):\n');
    await a.press('Ctrl+ ');
    await a.until(`!!document.querySelector('.suggest-widget.visible')`, 'suggest widget');
    const widgetAsked = (await serverStats(a)).requests;
    await a.sleep(1200);
    check(!(await ghost(a)) && (await serverStats(a)).requests === widgetAsked, 'no suggestion while the suggest widget is open');
    await a.press('Escape');
    await a.js(`(ide.settings.set('aiComplete.delay', 200), true)`);
    await a.js(`(() => { const m = ide.editor.getModel(); const n = ide.editor.getPosition().lineNumber; m.pushEditOperations([], [{ range: new ide.monaco.Range(n, 1, n, m.getLineMaxColumn(n)), text: '' }], () => null); ide.editor.setPosition({ lineNumber: n, column: 1 }); return true; })()`);
    await a.type('# say hello');
    const commentAsked = (await serverStats(a)).requests;
    await a.sleep(800);
    check(!(await ghost(a)) && (await serverStats(a)).requests === commentAsked, 'no automatic suggestion inside a comment');
    await a.press('Ctrl+Alt+\\');
    await a.until(`${GHOST} === ' to everyone'`, 'Ctrl+Alt+\\ ghost');
    check(true, 'Ctrl+Alt+\\ asks for a suggestion explicitly');
    await a.press('Escape');

    // ---------- toggle ----------
    await a.js(`ide.runAction('ToggleAICompletion')`);
    await a.until(`ide.aiComplete.mode() === 'off' && document.querySelector('#aiCompleteStatus').textContent.includes('off')`, 'off');
    await freshLine(a);
    const offAsked = (await serverStats(a)).requests;
    await typeCode(a, 'def greet(name):\n');
    await a.sleep(800);
    check(!(await ghost(a)) && (await serverStats(a)).requests === offAsked, 'turning AI completion off stops requests');
    await a.js(`ide.runAction('ToggleAICompletion')`);
    await a.until(`ide.aiComplete.mode() === 'on'`, 'back on');

    // ---------- status menu, settings dialog ----------
    await a.click('#aiCompleteStatus');
    await a.until(`!!document.querySelector('#aiCompleteMenu')`, 'status menu');
    check(await a.js(`document.querySelector('#aiCompleteMenu').textContent.includes('Snooze')`), 'the status bar item opens the AI Completion menu');
    await a.press('Escape');
    await a.js(`ide.runAction('AICompletionSettings')`);
    await a.until(`!!document.querySelector('#aicDelay')`, 'settings dialog');
    await a.js(`(() => { const set = (sel, prop, v, evt) => { const n = document.querySelector(sel); n[prop] = v; n.dispatchEvent(new Event(evt, { bubbles: true })); }; set('#aicDelay', 'value', '350', 'input'); set('#aicMultiline', 'checked', false, 'change'); set('#aicModel', 'value', 'qwen2.5-coder-1.5b', 'change'); return true; })()`);
    await a.click('.dialog-buttons .primary');
    check(await a.js(`ide.settings.get('aiComplete.delay') === 350 && ide.settings.get('aiComplete.multiline') === false`), 'Settings › AI › AI Completion saves its values');

    // ---------- Install Manager ----------
    await a.js(`(ide.installer.open('ai'), true)`);
    await a.until(`document.body.innerText.includes('Qwen2.5-Coder 0.5B') && document.body.innerText.includes('531 MB')`, 'installer rows');
    check(await a.js(`document.body.innerText.includes('Qwen2.5-Coder 1.5B')`), 'the Install Manager lists the completion models with their sizes');
    await a.shot('installer.png');
    check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${JSON.stringify(a.consoleErrors)}` : ''}`);
    await a.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
    a.close();

    // ---------- restart, Korean UI ----------
    b = await launch({ fixture: 'ai-complete', port: 9641, name: 'ai-complete-ko', lang: 'ko-KR', userData: a.userData });
    check(await b.js(`ide.settings.get('aiComplete.delay') === 350 && ide.settings.get('aiComplete.multiline') === false && ide.settings.get('aiComplete.model') === 'qwen2.5-coder-1.5b'`), 'settings persist across a restart');
    await openFile(b, 'main.py');
    await b.until(`ide.aiComplete.mode() === 'on'`, 'ready after restart');
    await b.click('#aiCompleteStatus');
    await b.until(`!!document.querySelector('#aiCompleteMenu')`, 'ko menu');
    const allowed = ['Qwen', 'Coder', 'llama', 'cpp', 'AI', 'MB', 'GB', 'Right'];
    const menuLeaks = await englishLeaks(b, '#aiCompleteMenu, #aiCompleteStatus', allowed);
    await b.press('Escape');
    await b.js(`ide.runAction('AICompletionSettings')`);
    await b.until(`!!document.querySelector('#aicDelay')`, 'ko settings');
    check(await b.js(`document.querySelector('#aicDelay').value === '350' && !document.querySelector('#aicMultiline').checked`), 'the settings dialog shows the saved values after a restart');
    const dialogLeaks = await englishLeaks(b, '.dialog', allowed);
    await b.shot('korean-settings.png');
    await b.press('Escape');
    await b.js(`(ide.installer.open('ai'), true)`);
    await b.until(`!!document.querySelector('.inst-card[data-id="ai:qwen2.5-coder-0.5b"]')`, 'ko installer');
    const cardLeaks = await englishLeaks(b, '.inst-card[data-id^="ai:qwen"]', allowed);
    const leaks = [...menuLeaks, ...dialogLeaks, ...cardLeaks];
    check(!leaks.length, `AI Completion UI is in Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
    await b.shot('korean-installer.png');
    check(b.consoleErrors.length === 0, `no renderer exceptions after restart${b.consoleErrors.length ? ` ${JSON.stringify(b.consoleErrors)}` : ''}`);
    b.close();
  }
} catch (err) {
  check(false, err.message);
  for (const t of [b, a]) {
    try {
      if (!t) continue;
      console.log(`  at failure: line ${JSON.stringify(await line(t))}, ghost ${JSON.stringify(await ghost(t))}, document tail ${JSON.stringify((await t.js('ide.editor.getModel().getValue()')).slice(-200))}`);
      await t.shot('failure.png');
      break;
    } catch {}
  }
  a?.close();
  b?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
