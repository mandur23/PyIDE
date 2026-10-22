// Korean UI of the debugger plugin, plus the Light theme while suspended. Every surface is exercised in a ko-KR
// session and checked for English UI text (englishLeaks) and for tr() strings without a Korean entry.
import { readFileSync } from 'fs';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const t = await launch({ fixture: 'debugger', port: 9442, name: 'i18n-debugger', lang: 'ko-KR' });
const { js, until, press, type, click, check, shot, cdp } = t;

// Every English string the plugin passes to tr().
const source = readFileSync(new URL('../renderer/features/debugger/index.js', import.meta.url), 'utf8');
const mine = new Set([...source.matchAll(/\btr\((['"])((?:(?!\1).)*)\1/g)].map((m) => m[2]));
const ko = JSON.parse(readFileSync(new URL('../renderer/features/debugger/locales/ko.json', import.meta.url), 'utf8'));

const hangul = (s) => /[가-힣]/.test(s || '');
async function noLeaks(selector, label) {
  const leaks = await englishLeaks(t, selector);
  check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` (${JSON.stringify(leaks.slice(0, 6))})` : ''}`);
}
async function noMissing(label) {
  const missing = (await missingTranslations(t)).filter((s) => mine.has(s));
  check(missing.length === 0, `${label}: every debugger tr() string seen so far has a Korean entry${missing.length ? ` (${JSON.stringify(missing)})` : ''}`);
}
const stoppedAt = (file, line) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith(${JSON.stringify(file)}) && f.line === ${line}; })()`, `suspended at ${file}:${line}`);
async function gutter(line, button = 'left') {
  const p = await js(`(() => { const e = ide.editor; e.revealLineInCenterIfOutsideViewport(${line}); const li = e.getLayoutInfo();
    const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
    return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
  await t.sleep(120);
}
const clickText = (sel, text) => js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find(n => n.textContent.includes(${JSON.stringify(text)})); if (!n) return false; n.id ||= 'dbgTmp' + Math.random().toString(36).slice(2); return n.id; })()`)
  .then((id) => { if (!id) throw new Error(`no ${sel} containing ${text}`); return click(`#${id}`); });
const rgb = (sel, prop) => js(`(() => { const n = (ide.editor.render(true), document).querySelector(${JSON.stringify(sel)}); return n && getComputedStyle(n)[${JSON.stringify(prop)}]; })()`);

try {
  check(await js(`i18n.locale === 'ko'`), 'session runs in Korean');
  const untranslated = [...mine].filter((s) => !(s in ko));
  check(untranslated.length === 0, `locales/ko.json covers every tr() string in index.js${untranslated.length ? ` (${JSON.stringify(untranslated)})` : ''}`);

  // ---- toolbar, actions, tool window before a session ----
  check(await js(`document.querySelector('#debugBtn').title`) === '디버그 (Shift+F9)', 'toolbar Debug button tooltip in Korean');
  const titles = await js(`ide.actions.filter(a => ['Debug','ToggleLineBreakpoint','ViewBreakpoints','StepOver','StepInto','StepOut','Resume','Pause','RunToCursor','EvaluateExpression','StopDebug','ActivateDebugToolWindow'].includes(a.id)).map(a => a.title)`);
  check(titles.length === 12 && titles.every(hangul), `debugger actions have Korean titles (${titles.join(', ')})`);
  check(await js(`ide.actions.find(a => a.id === 'StepOver').title`) === '단계 건너뛰기', 'Step Over is 단계 건너뛰기');
  await press('Alt+5');
  await until(`ide.toolWindows.get('Debug').isVisible()`, 'Debug tool window');
  check(await js(`ide.toolWindows.get('Debug').tab.textContent.includes('디버그')`), 'tool window tab title is 디버그');
  const tips = await js(`[...document.querySelectorAll('.dbg-bar .dbg-btn')].map(b => b.title)`);
  check(tips.length === 10 && tips.every(hangul), `toolbar button tooltips in Korean (${tips.join(' | ')})`);
  check(tips.includes('프로그램 재개 (F9)') && tips.includes('단계 진입 (F7)') && tips.includes('단계 나가기 (Shift+F8)') && tips.includes('커서까지 실행 (Alt+F9)')
    && tips.includes('표현식 평가 (Alt+F8)') && tips.includes('중단점 보기 (Ctrl+Shift+F8)') && tips.includes('프로그램 일시 중지') && tips.includes('다시 실행'),
  'tooltips use PyCharm Korean terms');
  check(await js(`[...document.querySelectorAll('.dbg-pane-head > span:first-child')].map(s => s.textContent).join()`) === '프레임,변수,감시', 'pane titles 프레임/변수/감시');
  check(await js(`document.querySelector('#dbgVars').textContent`) === '디버그 중이 아닙니다. Shift+F9(으)로 시작하세요', 'Variables empty state in Korean');
  await noLeaks('.dbg-root', 'Debug tool window without a session');
  await shot('idle.png');

  // ---- breakpoint popup (right-click on a breakpoint) ----
  await openFile(t, 'main.py');
  // The editor relayouts once the Debug window has opened, so a click right after may land before it settles.
  for (let i = 0; i < 5 && !(await js(`window.__debugger.breakpoints().length === 1`)); i++) {
    await t.sleep(300);
    await gutter(7);
  }
  if (!(await js(`window.__debugger.breakpoints().length === 1`))) console.log('gutter click not registered yet; overlay:', await js(`document.querySelector('.dialog-backdrop, .context-menu, .notification, .toast')?.outerHTML.slice(0, 300) || 'none'`));
  await until(`window.__debugger.breakpoints().length === 1`, 'breakpoint added');
  await gutter(7, 'right');
  await until(`!!document.querySelector('#dbgBpCondition')`, 'breakpoint popup');
  check(await js(`document.querySelector('.dbg-dialog').textContent.includes('조건:') && document.querySelector('.dbg-dialog').textContent.includes('사용')`), 'breakpoint popup labels in Korean');
  await noLeaks('#dialogHost', 'breakpoint popup');
  await shot('bp-popup.png');
  await js(`document.querySelector('#dbgBpCondition').focus()`);
  await type('v == 2');
  await press('Enter');
  await until(`!document.querySelector('#dbgBpCondition')`, 'popup closed');
  const hover = await js(`(() => { const d = ide.editor.getModel().getAllDecorations().find(d => d.options.glyphMarginClassName?.includes('dbg-bp cond')); return d?.options.glyphMarginHoverMessage?.value || ''; })()`);
  check(hover.includes('main.py의 7번째 줄') && hover.includes('조건:'), `breakpoint hover in Korean (${hover.replace(/\n/g, ' ')})`);

  // ---- tree context menu ----
  const node = await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === 'main.py'); if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  if (node) {
    for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: node.x, y: node.y, button: 'right', clickCount: 1, buttons: 2 });
    await until(`!!document.querySelector('.context-menu')`, 'tree context menu');
    check(await js(`document.querySelector('.context-menu').textContent.includes("'…' 디버그")`), "project tree menu shows '…' 디버그");
    await press('Escape');
    await js(`document.querySelector('.context-menu')?.remove(), true`);
  } else check(false, 'main.py node in the project tree');

  // ---- suspended: frames, variables, watches ----
  await press('Ctrl+S');
  await press('Shift+F9');
  await stoppedAt('main.py', 7);
  await until(`document.querySelector('#dbgVars').textContent.includes('total')`, 'variables loaded');
  check(await js(`document.querySelector('.dbg-thread').textContent`) === 'MainThread · 중단점', 'thread label shows the stop reason in Korean');
  check(await js(`document.querySelector('#dbgTabVars').textContent === '스레드 및 변수' && document.querySelector('#dbgTabConsole').textContent === '콘솔'`), 'sub-tabs 스레드 및 변수 / 콘솔');
  check((await js(`document.querySelector('#dbgVars').textContent`)).includes('total = {int} 10'), 'variable names, types and values stay as program data');
  await clickText('#dbgFrames .dbg-frame', '<module>');
  await until(`document.querySelector('#dbgVars').textContent.includes('info = {dict}')`, 'module frame');
  await clickText('#dbgFrames .dbg-frame', 'compute');
  await until(`document.querySelector('#dbgVars').textContent.includes('total = {int} 10')`, 'top frame again');
  // debugpy's scope / bucket labels
  const groups = await js(`[...document.querySelectorAll('#dbgVars .dbg-group .dbg-name')].map(n => n.textContent)`);
  if (groups.includes('전역')) {
    await clickText('#dbgVars .dbg-group', '전역');
    await until(`[...document.querySelectorAll('#dbgVars .dbg-group .dbg-name')].some(n => n.textContent === '특수 변수')`, 'special variables bucket');
  }
  const groups2 = await js(`[...document.querySelectorAll('#dbgVars .dbg-group .dbg-name')].map(n => n.textContent)`);
  check(groups2.length > 0 && groups2.every(hangul), `scope and bucket labels in Korean (${groups2.join(', ')})`);

  await click('#dbgWatchAdd');
  check(await js(`document.querySelector('#dbgWatchInput').placeholder`) === '감시할 표현식 (Enter)', 'watch input placeholder in Korean');
  await js(`document.querySelector('#dbgWatchInput').focus()`);
  await type('total * 2');
  await press('Enter');
  await until(`document.querySelector('#dbgWatches').textContent.includes('total * 2 = {int} 20')`, 'watch value');
  await click('#dbgWatchAdd');
  await js(`document.querySelector('#dbgWatchInput').focus()`);
  await type('missing_name');
  await press('Enter');
  await until(`!!document.querySelector('#dbgWatches .dbg-err')`, 'watch error');
  check(await js(`document.querySelector('#dbgWatches .dbg-err').textContent.includes('NameError')`), 'debugpy exception text is shown untranslated');
  check(await js(`document.querySelector('#dbgWatches .dbg-watch-del').title`) === '감시 제거', 'watch delete tooltip in Korean');
  await noLeaks('.dbg-root', 'Debug tool window while suspended');
  await shot('suspended-ko.png');

  // ---- Light theme while suspended ----
  await js(`ide.settings.set('appearance.theme', 'light'), true`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await t.sleep(300);
  check(await rgb('#editor .dbg-exec-line', 'backgroundColor') === 'rgb(213, 225, 255)', 'Light: execution line #d5e1ff');
  check(await rgb('#editor .dbg-bp', 'color') !== null && await js(`getComputedStyle((ide.editor.render(true), document).querySelector('#editor .dbg-bp'), '::before').backgroundColor`) === 'rgb(219, 59, 75)', 'Light: breakpoint red #db3b4b');
  check(await rgb('#dbgVars .dbg-var:not(.dbg-group) .dbg-name', 'color') === 'rgb(135, 16, 148)', 'Light: variable names #871094');
  check(await rgb('#dbgVars .dbg-value.num', 'color') === 'rgb(23, 80, 235)', 'Light: numbers #1750eb');
  check(await rgb('#dbgWatches .dbg-err', 'color') === 'rgb(199, 34, 45)', 'Light: errors readable red');
  check(await rgb('#editor .dbg-inline-val', 'color') === 'rgb(140, 140, 140)', 'Light: inline values gray');
  check(await rgb('.dbg-root', 'backgroundColor') === 'rgb(255, 255, 255)', 'Light: tool window background');
  await shot('suspended-light.png');

  // ---- console ----
  await click('#dbgTabConsole');
  check(await js(`document.querySelector('#dbgOut').textContent.includes('pydev 디버거에 연결됨')`), 'console connection message in Korean');
  check(await js(`document.querySelector('#dbgIn').placeholder.startsWith('stdin: 프로그램 입력') && document.querySelector('#dbgConsoleEval').placeholder === '선택한 프레임에서 표현식 평가 (Enter)'`), 'console placeholders in Korean');
  await js(`document.querySelector('#dbgConsoleEval').focus()`);
  await type('total + 1');
  await press('Enter');
  await until(`/>>> total \\+ 1\\s+11/.test(document.querySelector('#dbgOut').textContent)`, 'console eval result');
  await noLeaks('.dbg-root', 'Debug console');
  await click('#dbgTabVars');

  // ---- evaluate dialog ----
  await press('Alt+F8');
  await until(`!!document.querySelector('#dbgEvalInput')`, 'evaluate dialog');
  check(await js(`document.querySelector('.dbg-dialog .dialog-title').textContent`) === '평가', 'evaluate dialog title 평가');
  check(await js(`[...document.querySelectorAll('.dbg-dialog .dialog-buttons button')].map(b => b.textContent).join()`) === '평가,닫기,감시 추가', 'evaluate dialog buttons in Korean');
  await js(`(document.querySelector('#dbgEvalInput').value = '', document.querySelector('#dbgEvalInput').focus())`);
  await type('{"sum": sum(values)}');
  await press('Enter');
  await until(`document.querySelector('#dbgEvalResult').textContent.includes('{dict}')`, 'evaluate result');
  check(await js(`document.querySelector('#dbgEvalResult .dbg-name').textContent`) === '결과', 'evaluate result row labelled 결과');
  await noLeaks('#dialogHost', 'evaluate dialog');
  await shot('evaluate-light.png');
  await press('Escape');
  await until(`!document.querySelector('#dbgEvalInput')`, 'evaluate closed');

  // ---- breakpoints dialog ----
  await press('Ctrl+Shift+F8');
  await until(`!!document.querySelector('#dbgBpList')`, 'breakpoints dialog');
  check(await js(`document.querySelector('.dbg-bps-group').textContent`) === 'Python 줄 중단점 (1)', 'breakpoints list group in Korean');
  check(await js(`document.querySelector('#dbgBpList').textContent.includes('main.py:7') && document.querySelector('#dbgBpList').textContent.includes('v == 2')`), 'breakpoint file:line and condition stay as is');
  await noLeaks('#dialogHost', 'breakpoints dialog');
  await shot('breakpoints-light.png');
  await press('Escape');
  await until(`!document.querySelector('#dbgBpList')`, 'breakpoints dialog closed');

  // ---- running state, then the program ends ----
  await js(`ide.settings.set('appearance.theme', 'dark'), true`);
  await press('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('name?')`, 'program waits for input');
  await click('#dbgTabVars');
  await until(`document.querySelector('.dbg-thread').textContent === '실행 중'`, 'running label');
  check(await js(`document.querySelector('#dbgFrames').textContent`) === '일시 중지 상태가 아닐 때는 프레임을 사용할 수 없습니다', 'Frames empty state while running in Korean');
  check(await js(`document.querySelector('#dbgWatches').textContent.includes('(일시 중지되지 않음)')`), 'watches show (일시 중지되지 않음) while running');
  await noLeaks('.dbg-root', 'Debug tool window while running');
  await click('#dbgTabConsole');
  await until(`document.activeElement?.id === 'dbgIn'`, 'stdin focused');
  await type('Ann');
  await press('Enter');
  await until(`document.querySelector('#dbgOut').textContent.includes('종료 코드 0(으)로 완료된 프로세스')`, 'program finished');
  check(await js(`document.querySelector('#dbgOut').textContent.includes('result=60 name=Ann')`), 'program output untouched');
  // Console eval outside a session reports in Korean
  await js(`document.querySelector('#dbgConsoleEval').focus()`);
  await type('1');
  await press('Enter');
  check(await js(`document.querySelector('#dbgOut').textContent.includes('프로그램이 일시 중지된 동안에만 평가할 수 있습니다')`), 'evaluation outside suspension reported in Korean');
  await click('#dbgTabVars');
  await noLeaks('.dbg-root', 'Debug tool window after the session');
  await shot('finished-ko.png');

  await noMissing('end of run');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
