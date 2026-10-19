// Korean UI of the My Workspace plugin (Launchers tool window, port dialog, Workspace home), in Dark and Light.
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(APP_DIR, 'renderer', 'features', 'workspace');
const S = JSON.stringify;
process.env.PYIDE_FAKE_OPEN_EXTERNAL = '1';

// ---------- static: every string passed to tr() has a Korean entry ----------
function trStrings(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Set();
  const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/y;
  for (let i = src.indexOf('tr('); i >= 0; i = src.indexOf('tr(', i + 1)) {
    if (/[\w.]/.test(src[i - 1] || '')) continue;
    let depth = 0;
    for (let j = i + 2; j < src.length; j++) {
      const c = src[j];
      if (c === "'" || c === '"') {
        lit.lastIndex = j;
        const m = lit.exec(src);
        out.add((m[1] ?? m[2]).replace(/\\'/g, "'"));
        j = lit.lastIndex - 1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
  }
  return out;
}
const ko = JSON.parse(readFileSync(path.join(PLUGIN, 'locales', 'ko.json'), 'utf8'));
const meta = JSON.parse(readFileSync(path.join(PLUGIN, 'plugin.json'), 'utf8'));
const mine = trStrings(path.join(PLUGIN, 'index.js'));
const staticMissing = [...mine, meta.name, meta.description].filter((s) => !(s in ko));

const t = await launch({ fixture: 'workspace', port: 9462, name: 'i18n-workspace', lang: 'ko-KR' });
const { js, until, press, type, click, shot, check, sleep } = t;
const q = JSON.stringify;
const leaks = async (selector, label) => {
  const found = await englishLeaks(t, selector);
  check(found.length === 0, `no English left in ${label}${found.length ? ` (${S(found)})` : ''}`);
};
const rowExpr = (name) => `[...document.querySelectorAll('#wsList .ws-row')].find(r => r.querySelector('.ws-name').textContent === ${q(name)})`;
async function clickNode(expr, label) {
  const ok = await js(`(() => { document.querySelectorAll('.pick-me').forEach(n => n.classList.remove('pick-me')); const n = ${expr}; if (!n) return false; n.classList.add('pick-me'); n.scrollIntoView({ block: 'nearest' }); return true; })()`);
  if (!ok) throw new Error(`not found: ${label}`);
  await click('.pick-me');
}
const detailOut = () => js(`document.querySelector('#wsDetail .ws-console:not(.hidden) .console')?.textContent || ''`);
let blocker;

try {
  check(staticMissing.length === 0, `every tr() string and the plugin name/description have Korean entries${staticMissing.length ? ` (${S(staticMissing)})` : ''}`);
  check(await js(`i18n.locale === 'ko'`), 'session runs in Korean');

  // ---------- home ----------
  await until(`!!document.querySelector('#wsHome .ws-project-name') && document.querySelectorAll('#wsHome .ws-pill').length >= 7`, 'home with launchers');
  check(await js(`document.querySelector('.tab.active .name').textContent === '워크스페이스'`), 'home tab title in Korean');
  const titles = await js(`[...document.querySelectorAll('#wsHome .ws-card-head h3, #wsHome .ws-side-title')].map(n => n.textContent)`);
  check(S(titles) === S(['최근 프로젝트', '실행 도구', '가상 환경', 'README']), `home section titles in Korean (${titles})`);
  check(await js(`document.querySelector('#wsHome .ws-recent .ws-when').textContent === '오늘'`), 'recent project date "오늘"');
  check(await js(`document.querySelector('#wsHome .ws-branch').textContent.includes('Git 저장소 없음')`), 'no-repository chip in Korean');
  await leaks('#wsHome', 'the Workspace home');
  check(await js(`document.querySelector('#toolbarLeft .ws-home-btn').title === '워크스페이스 홈'`), 'toolbar item title in Korean');
  await shot('home-dark.png');

  // ---------- Launchers tool window ----------
  await press('Alt+Shift+L');
  await until(`ide.toolWindows.get('Launchers').isVisible()`, 'Launchers tool window');
  check(await js(`document.querySelector('#sideTitle').textContent === '실행 도구'`), 'tool window title "실행 도구"');
  check(await js(`ide.toolWindows.get('Launchers').button.title === '실행 도구 (Alt+Shift+L)'`), 'stripe button tooltip in Korean');
  const groupTitles = await js(`[...document.querySelectorAll('#wsList .ws-group-title')].map(n => n.textContent)`);
  check(S(groupTitles) === S(['시작 구성', 'PyCharm 실행 구성', 'Python 모듈', 'Python 스크립트', '배치 스크립트', 'PowerShell 스크립트', 'Maven 목표']), `launcher groups in Korean (${groupTitles})`);
  await leaks('#wsTool', 'the empty Launchers tool window');
  await clickNode(rowExpr('tool.py'), 'tool.py row');
  await until(`document.querySelector('#wsDetail .ws-detail-name')?.textContent === 'tool.py'`, 'tool.py detail');
  const labels = await js(`[...document.querySelectorAll('#wsDetail .ws-field > span, #wsDetail .ws-meta-row > .muted')].map(n => n.textContent)`);
  check(S(labels) === S(['인수:', '작업 디렉터리:', '인터프리터:', 'argparse 옵션:']), `detail labels in Korean (${labels})`);
  check(await js(`document.querySelector('#wsArgs').placeholder === '추가 명령줄 인수'`), 'arguments placeholder in Korean');
  await leaks('#wsTool', 'the launcher detail pane');

  await clickNode(rowExpr('python -m app'), 'app row');
  await click('#wsDetail .ws-detail-run');
  await until(`document.querySelector('#wsDetail .ws-console:not(.hidden) .console')?.textContent.includes('종료 코드 0(으)로 완료된 프로세스')`, 'Korean exit line', 20000);
  check((await detailOut()).includes('Hello from app, world'), 'launcher output passes through untranslated');

  // ---------- port dialog ----------
  blocker = spawn(process.execPath, ['-e', "require('net').createServer().listen(8799, '127.0.0.1', () => console.log('ready'))"]);
  await new Promise((r) => blocker.stdout.on('data', (d) => d.toString().includes('ready') && r()));
  await clickNode(`${rowExpr('Static Server')}?.querySelector('.ws-run')`, 'Static Server run');
  await until(`!!document.querySelector('.ws-port-dialog')`, 'port dialog', 20000);
  const dlg = await js(`({ title: document.querySelector('.dialog-title').textContent, body: document.querySelector('.ws-port-dialog').textContent, buttons: [...document.querySelectorAll('.dialog-buttons button')].map(b => b.textContent) })`);
  check(dlg.title === '포트 8799 사용 중', `port dialog title in Korean (${dlg.title})`);
  check(dlg.body.startsWith('포트 8799은(는) 이미 node.exe(PID ') && dlg.body.includes("지금 'Static Server'을(를) 시작하면"), `port dialog text in Korean (${dlg.body})`);
  check(S(dlg.buttons) === S(['해당 프로세스 중지', '무시하고 실행', '취소']), `port dialog buttons in Korean (${dlg.buttons})`);
  await leaks('.dialog', 'the port dialog');
  await shot('port-dialog-ko.png');
  await clickNode(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === '해당 프로세스 중지')`, 'stop button');
  await until(`!!document.querySelector('.ws-confirm')`, 'terminate confirmation');
  check(await js(`document.querySelector('.dialog-title').textContent === '프로세스 중지' && [...document.querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|') === '종료|취소'`), 'terminate confirmation in Korean');
  await leaks('.dialog', 'the terminate confirmation');
  await clickNode(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === '종료')`, 'terminate');
  await until(`!!document.querySelector('#wsDetail .ws-link')`, 'server URL detected', 30000);
  check(await js(`document.querySelector('#wsDetail .ws-link').textContent === '브라우저에서 열기' && document.querySelector('#wsList .ws-open').title === '브라우저에서 열기'`), '"Open in Browser" in Korean');
  check((await detailOut()).includes('node.exe(PID') && (await detailOut()).includes('중지했습니다'), 'stopped-process console line in Korean');
  await leaks('#wsTool', 'the Launchers tool window with a running server');
  await leaks('#wsHome', 'the home with a running server');
  await shot('launchers-dark.png');

  // ---------- Light theme ----------
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await sleep(200);
  if (!(await js(`document.documentElement.dataset.theme === 'light'`))) await js(`(document.documentElement.dataset.theme = 'light', true)`);
  await js(`ide.workspace.openHome()`);
  await sleep(200);
  const light = await js(`(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s));
    return { home: cs('#wsHome').backgroundColor, card: cs('#wsHome .ws-card').backgroundColor, name: cs('#wsHome .ws-project-name').color,
      side: cs('#wsHome .ws-home-side').backgroundColor, tool: cs('#wsTool').backgroundColor, rowName: cs('#wsList .ws-name').color, sub: cs('#wsList .ws-sub').color };
  })()`);
  check(light.home === 'rgb(255, 255, 255)' && light.card === 'rgb(247, 248, 250)' && light.name === 'rgb(0, 0, 0)' && light.side === 'rgb(247, 248, 250)', `Light home colors (${S(light)})`);
  check(light.tool === 'rgb(247, 248, 250)' && light.rowName === 'rgb(0, 0, 0)' && light.sub === 'rgb(129, 133, 148)', 'Light Launchers colors');
  await shot('workspace-light.png');
  await clickNode(`${rowExpr('Static Server')}?.querySelector('.ws-run')`, 'stop server');
  await until(`!document.querySelector('#wsList .ws-open')`, 'server stopped');

  // ---------- runtime: nothing this plugin asked tr() for is missing ----------
  const missing = (await missingTranslations(t)).filter((s) => mine.has(s));
  check(missing.length === 0, `no missing Korean strings from the workspace plugin${missing.length ? ` (${S(missing)})` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
} finally {
  try { blocker?.kill(); } catch {}
}
t.finish();
