// Program output in the IDE's consoles: \r progress lines, \b, ANSI colors, traceback links, the size cap, a flood of
// output, following the end while the user scrolls with the wheel, stray escape sequences, the Python Packages
// console's stderr colors, and main's output batching (main/output-batch.js).
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const require = createRequire(import.meta.url);
const { outputBatch } = require('../main/output-batch.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const batchResults = [];
{
  const sent = [];
  const b = outputBatch((text, key) => sent.push(`${key}:${text}`), { ms: 20 });
  b.push('a', 'out');
  batchResults.push([sent.join() === 'out:a', 'the first chunk after a quiet window is sent at once']);
  b.push('b', 'out');
  b.push('c', 'err');
  b.push('d', 'err');
  b.push('e', 'out');
  batchResults.push([sent.length === 1, 'chunks within the window wait']);
  await wait(60);
  batchResults.push([sent.join() === 'out:a,out:b,err:cd,out:e', `the window's chunks arrive joined per stream, in order (${sent.join()})`]);
  sent.length = 0;
  b.push('f', 'out');
  batchResults.push([sent.join() === 'out:f', 'after a quiet window the next chunk is sent at once again']);
  b.push('g', 'out');
  b.flush();
  batchResults.push([sent.join() === 'out:f,out:g', 'flush() sends what is pending']);
  const big = [];
  const m = outputBatch((text) => big.push(text.length), { ms: 1000, max: 100 });
  m.push('x');
  m.push('y'.repeat(60));
  m.push('z'.repeat(60));
  batchResults.push([big.join() === '1,120', `a batch past max characters is sent without waiting for the window (${big.join()})`]);
  m.flush();
}

const t = await launch({ fixture: 'core', port: 9290, name: 'console-output' });
const { js, until, check, click, cdp, sleep } = t;
for (const [ok, label] of batchResults) check(ok, label);

const put = (name, text) => writeFileSync(path.join(t.project, name), text);
put('progress.py', [
  'import sys, time',
  'for i in range(60):',
  '    sys.stdout.write(f"\\rdownloading {i}/59")',
  '    sys.stdout.flush()',
  '    time.sleep(0.003)',
  'print()',
  'print("\\x1b[31mRED\\x1b[0m \\x1b[1mBOLD\\x1b[0m plain")',
  'def fail():',
  '    raise ValueError("boom")',
  'fail()',
  '',
].join('\n'));
put('spam.py', 'for i in range(100000):\n    print(f"line {i:06d} lorem ipsum dolor sit amet consectetur")\nprint("SPAM-DONE")\n');
put('colors.py', 'print("\\x1b[32mGREEN\\x1b[0m done")\n');

try {
  // ---- the console primitive ----
  await js(`(() => {
    const host = document.createElement('div');
    host.id = 'conTest';
    host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;display:flex;z-index:100000;background:#000';
    document.body.appendChild(host);
    window.__con = ide.ui.console(host);
    window.__feed = (chunks, cls) => { __con.clear(); for (const c of chunks) __con.append(c, cls); return __con.text(); };
    return true;
  })()`);
  const feed = (chunks, cls) => js(`__feed(${JSON.stringify(chunks)}, ${JSON.stringify(cls ?? null)})`);
  check(await feed(['downloading 1/3', '\rdownloading 2/3', '\rdownloading 3/3\n']) === 'downloading 3/3\n', '\\r rewrites the current line');
  check(await feed(['10%\r20%\r30%\rdone\n']) === 'done\n', 'several \\r frames in one chunk leave the last one');
  check(await feed(['long line here\rshort\n']) === 'shortline here\n', 'text after \\r overwrites only as many characters as it has, like a terminal');
  check(await feed(['a\r', '\nb\r\n', 'c']) === 'a\nb\nc', 'a \\r\\n split across chunks is one line break');
  check(await feed(['|\b/\b-\n']) === '-\n', '\\b steps back over a spinner');
  check(await feed(['abcdef\r\x1b[Kxy\n']) === 'xy\n', 'ESC[K erases the rest of the line');
  check(await feed(['\x1b]0;title\x07x\x1b[2Ay\n']) === 'xy\n', 'window titles and cursor moves are dropped');
  check(await feed(['\x1b[31mRED\x1b[0m plain \x1b[1;38;5;208mORANGE\x1b[0m \x1b[38;2;10;20;30mTC\x1b[0m\n']) === 'RED plain ORANGE TC\n', 'SGR sequences leave only the text');
  const styles = await js(`(() => {
    const at = (t) => [...document.querySelectorAll('#conTest span')].find((s) => s.childNodes.length === 1 && s.textContent === t);
    const cs = (t) => at(t) && getComputedStyle(at(t));
    return { red: at('RED')?.className, redColor: cs('RED')?.color, plainColor: getComputedStyle(document.querySelector('#conTest pre')).color,
      orange: cs('ORANGE')?.color, orangeWeight: cs('ORANGE')?.fontWeight, tc: cs('TC')?.color };
  })()`);
  check(styles.red === 'ansi-fg1' && styles.redColor !== styles.plainColor, `a 16-color foreground is a themed class with its color (${styles.redColor})`);
  check(styles.orange === 'rgb(255, 135, 0)' && styles.orangeWeight === '700', `256-color and bold render (${styles.orange}, ${styles.orangeWeight})`);
  check(styles.tc === 'rgb(10, 20, 30)', `24-bit color renders (${styles.tc})`);
  check(await feed(['\x1b[3', '2mGREEN\x1b[0m\n']) === 'GREEN\n' && await js(`!!document.querySelector('#conTest .ansi-fg2')`), 'an escape sequence split across chunks still applies');
  check(await feed(['\x1b[33m', 'Y1\n', 'Y2\x1b[0m\n']) === 'Y1\nY2\n' && await js(`[...document.querySelectorAll('#conTest .ansi-fg3')].map((s) => s.textContent).join('') === 'Y1\\nY2'`), 'a color carries over to the next chunks');
  check(await feed(['50%', ' warning\n'], 'err') === '50% warning\n' && await js(`__con.out.lastElementChild.className === 'err'`), 'the stream class (err) is kept');
  await feed(['  File "C:/x/m', 'od.py", line 7, in f\n'], 'err');
  check(await js(`[...__con.out.querySelectorAll('a')].map((a) => a.textContent).join('|') === 'File "C:/x/mod.py", line 7'`), 'a traceback frame split across chunks is one link');
  check(await feed(['Name: ']) === 'Name: ' && await js(`__con.out.lastElementChild.textContent === 'Name: '`), 'an unfinished line (an input() prompt) shows at once');
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`);
  const stray = await feed(['start\n\x1b]0;title-without-terminator', ...lines]);
  check(stray.endsWith('line 1999\n') && (stray.match(/line \d+\n/g) || []).length === 2000, `a stray ESC ] (an OSC sequence with no end) does not hide the 2,000 lines after it (${stray.length} characters)`);
  const longOsc = await feed(['x\x1b]', ...Array(20).fill('a'.repeat(100))]);
  check(longOsc === `x]${'a'.repeat(2000)}`, `an ESC ] longer than any real sequence is written out as text, not held (${longOsc.length} characters)`);
  const interleaved = await js(`(() => { __con.clear(); for (const [s, c] of ${JSON.stringify([['a \x1b[3', null], ['warn\n', 'err'], ['1mRED\x1b[0m\n', null]])}) __con.append(s, c);
    return { text: __con.text(), red: [...document.querySelectorAll('#conTest .ansi-fg1')].map((s) => s.textContent).join('') }; })()`);
  check(interleaved.text === 'a warn\nRED\n' && interleaved.red === 'RED', `an escape sequence split by the other stream's output still applies (${JSON.stringify(interleaved)})`);

  await js(`(ide.settings.set('console.cycleBufferKB', 64), true)`);
  const capped = await js(`(() => {
    __con.clear();
    for (let i = 0; i < 400; i++) __con.append(\`row \${String(i).padStart(4, '0')} \${'x'.repeat(990)}\\n\`);
    const text = __con.text();
    return { len: text.length, first: text.slice(0, 8), last: text.slice(-1000, -990) };
  })()`);
  await js(`(ide.settings.set('console.cycleBufferKB', 1024), true)`);
  check(capped.len >= 63 * 1024 && capped.len <= 128 * 1024 + 1000, `the console keeps about its cycle buffer size (${capped.len} characters of 400,000)`);
  check(/^row \d{4}/.test(capped.first) && capped.last === 'row 0399 x', `the oldest lines go first, cut at a line start (${capped.first} ... ${capped.last})`);
  const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
  const gap = () => js(`${frames}.then(() => __con.out.scrollHeight - __con.out.scrollTop - __con.out.clientHeight)`);
  const wheel = async (deltaY, times = 1) => {
    for (let i = 0; i < times; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 100, deltaX: 0, deltaY });
    await sleep(300);
  };
  const appendRows = (tag) => js(`(() => { for (let i = 0; i < 200; i++) __con.append('${tag} ' + i + '\\n'); return ${frames}.then(() => true); })()`);
  await js('(__con.clear(), true)');
  await appendRows('a');
  const followed = await gap() < 40;
  await wheel(-100000);
  const top = await js('__con.out.scrollTop');
  await appendRows('b');
  const stayed = top === 0 && await js('__con.out.scrollTop') === 0;
  await wheel(100000);
  await appendRows('c');
  check(followed && stayed && await gap() < 40, `output follows the end, stops while the user is scrolled up with the wheel, and follows again at the end (followed ${followed}, stayed ${stayed})`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: 200, y: 100, button: 'left', clickCount: 1 });
  for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 });
  await sleep(300);
  await appendRows('d');
  const paged = await gap();
  check(paged > 40, `PageUp in the clicked console stops the following too (${Math.round(paged)} px from the end)`);
  // A flood that trims the console every frame (64 KB kept, 80 KB a frame): the wheel still stops the following.
  await js(`(ide.settings.set('console.cycleBufferKB', 64), true)`);
  const flooding = (on) => js(on ? `(() => { __con.clear(); window.__flooding = true; const chunk = ('y'.repeat(79) + '\\n').repeat(1024);
    const loop = () => { if (!window.__flooding) return; __con.append(chunk); requestAnimationFrame(loop); }; loop(); return true; })()` : '(window.__flooding = false, true)');
  await flooding(true);
  await sleep(500);
  await wheel(-300, 4);
  await sleep(1200);
  await flooding(false);
  const floodUp = await gap();
  await flooding(true);
  await sleep(500);
  await wheel(-300, 4);
  await sleep(500);
  await wheel(100000, 3);
  await sleep(800);
  await flooding(false);
  const floodBack = await gap();
  await js(`(ide.settings.set('console.cycleBufferKB', 1024), true)`);
  check(floodUp > 1000, `during a flood that trims the console, the wheel up stops the following (${Math.round(floodUp)} px from the end)`);
  check(floodBack < 40, `during the flood, the wheel back down to the end follows again (${Math.round(floodBack)} px from the end)`);
  await js(`(document.getElementById('conTest').remove(), true)`);

  // ---- Python Packages: stderr colored per line ----
  const pkg = await js(`(async () => {
    const attach = ide.proc.attach;
    ide.proc.attach = (id, h) => {
      ide.proc.attach = attach;
      h.data('Collecting nothere\\n', 'out');
      h.data('WARNING: Retrying after a broken connection\\nERROR: No matching distribution found for nothere\\n', 'err');
      h.data('WARNING: pip is', 'err');
      h.data(' out of date\\n', 'err');
      h.exit(1);
    };
    await ide.packages.run('Probe', async () => ({ id: 'probe-1' }));
    const out = document.getElementById('pkgOut');
    const classOf = (needle) => {
      const w = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) return n.parentElement.className;
      return 'missing';
    };
    return { warning: classOf('WARNING: Retrying'), error: classOf('ERROR: No matching'), split: classOf(' out of date') };
  })()`);
  check(pkg.warning === '' && pkg.error === 'err' && pkg.split === '', `Python Packages colors each stderr line: a WARNING and an ERROR in one message, a warning split over two (${JSON.stringify(pkg)})`);

  // ---- Run: progress, colors and traceback links ----
  await openFile(t, 'progress.py');
  await js(`ide.run.runCurrentFile().then(() => true)`);
  const runText = () => js(`ide.run.activeSession()?.con?.text() || ''`);
  await until(`/Process finished/.test(ide.run.activeSession()?.con?.text() || '')`, 'progress.py finished', 30000);
  const text = await runText();
  check((text.match(/downloading/g) || []).length === 1 && text.includes('downloading 59/59\n'), `the progress line updates in place (${JSON.stringify(text.slice(text.indexOf('downloading'), text.indexOf('downloading') + 40))})`);
  const run = await js(`(() => {
    const out = document.getElementById('runOut');
    const red = [...out.querySelectorAll('span')].find((s) => s.textContent === 'RED');
    const bold = [...out.querySelectorAll('span')].find((s) => s.textContent === 'BOLD');
    const link = [...out.querySelectorAll('a')].find((a) => /progress\\.py", line 9/.test(a.textContent));
    if (link) link.id = 'runLink';
    return { red: red && getComputedStyle(red).color, plain: getComputedStyle(out).color, bold: bold && getComputedStyle(bold).fontWeight, link: !!link };
  })()`);
  check(run.red && run.red !== run.plain, `RED prints in red in the Run console (${run.red})`);
  check(run.bold === '700', 'bold text is bold in the Run console');
  check(run.link, 'the traceback frame is a link');
  if (run.link) {
    const at = await js(`(() => { const a = document.getElementById('runLink'); a.scrollIntoView({ block: 'center' }); const r = a.getClientRects()[0]; return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await until(`ide.activeTab()?.path?.endsWith('progress.py') && ide.editor.getPosition().lineNumber === 9`, 'link opens progress.py:9', 10000).catch(() => {});
    const opened = await js(`(() => { const a = document.getElementById('runLink'); const r = a?.getBoundingClientRect(); const top = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { path: ide.activeTab()?.path, line: ide.editor.getPosition()?.lineNumber, link: a?.textContent, box: r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], hit: top && (top === a || a.contains(top) ? 'link' : top.className || top.tagName), view: [innerWidth, innerHeight] }; })()`);
    check(opened.path?.endsWith('progress.py') && opened.line === 9, `clicking the link opens the file at the frame line (${JSON.stringify(opened)})`);
  }

  // ---- Run: a flood of 100,000 lines ----
  await openFile(t, 'spam.py');
  const flood = await js(`(async () => {
    const t0 = performance.now();
    await ide.run.runCurrentFile();
    const s = () => ide.run.activeSession();
    while (performance.now() - t0 < 120000 && !/Process finished/.test(s()?.con?.out.lastElementChild?.textContent || '')) await new Promise((r) => setTimeout(r, 50));
    const ms = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = s().con.out;
    const text = s().con.text();
    return { ms, len: text.length, start: text.slice(0, 12), done: text.includes('line 099999 lorem') && text.includes('SPAM-DONE'), atEnd: out.scrollHeight - out.scrollTop - out.clientHeight < 40 };
  })()`);
  console.log(`flood: ${Math.round(flood.ms)} ms, ${flood.len} characters kept`);
  check(flood.done, 'the flood\'s last lines and the exit line are shown');
  check(flood.ms < 30000, `100,000 lines print in under 30 s (${Math.round(flood.ms)} ms)`);
  check(flood.len <= 1024 * 1024 + 65536 + 200 && /^line \d{6}/.test(flood.start), `the Run console keeps the last 1024 KB from a line start (${flood.len} characters, starts ${JSON.stringify(flood.start)})`);
  check(flood.atEnd, 'the Run console is scrolled to the end after the flood');

  // ---- Debug console ----
  await openFile(t, 'colors.py');
  await js(`(ide.debugger.debugFile(ide.util.joinPath(ide.root, 'colors.py')), true)`);
  await until(`/Process finished/.test(document.querySelector('.dbg-console pre')?.textContent || '')`, 'colors.py debugged', 60000);
  check(await js(`[...document.querySelectorAll('.dbg-console pre .ansi-fg2')].some((s) => s.textContent === 'GREEN')`), 'the Debug console renders ANSI colors');
} catch (err) {
  check(false, err.message);
}
t.finish();
