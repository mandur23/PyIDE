// Program output in the IDE's consoles: \r progress lines, \b, ANSI colors, traceback links, the size cap, a flood of
// output, and main's output batching (main/output-batch.js).
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
const { js, until, check, click } = t;
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
    host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;display:flex';
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
  const scrolling = await js(`(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = __con.out;
    const atEnd = () => out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    __con.clear();
    for (let i = 0; i < 200; i++) __con.append(\`a \${i}\\n\`);
    await frames();
    const followed = atEnd();
    out.scrollTop = 0;
    await frames();
    for (let i = 0; i < 200; i++) __con.append(\`b \${i}\\n\`);
    await frames();
    const stayed = out.scrollTop === 0;
    out.scrollTop = out.scrollHeight;
    await frames();
    for (let i = 0; i < 200; i++) __con.append(\`c \${i}\\n\`);
    await frames();
    return { followed, stayed, again: atEnd() };
  })()`);
  check(scrolling.followed && scrolling.stayed && scrolling.again, `output follows the end, stops while the user is scrolled up, and follows again at the end (${JSON.stringify(scrolling)})`);
  await js(`(document.getElementById('conTest').remove(), true)`);

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
    await click('#runLink');
    await until(`ide.activeTab()?.path?.endsWith('progress.py') && ide.editor.getPosition().lineNumber === 9`, 'link opens progress.py:9', 10000).catch(() => {});
    check(await js(`ide.activeTab()?.path?.endsWith('progress.py') && ide.editor.getPosition().lineNumber === 9`), 'clicking the link opens the file at the frame line');
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
