// End-to-end check for the frameworks plugin (renderer/features/frameworks, main/features/frameworks.js) on real
// Django, Flask and FastAPI fixture projects. Django, Flask, FastAPI and uvicorn are installed into a fresh temp venv
// through the Install Manager's pip items; FRAMEWORKS_VENV=<python.exe> reuses a venv that already has them.
// IDE ports 9740-9743, dev server ports 9745-9747.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'frameworks');
const PACKAGES = ['django', 'flask', 'fastapi', 'uvicorn'];
const imports = (py, mods) => { try { execFileSync(py, ['-c', `import ${mods.join(', ')}`], { stdio: 'ignore' }); return true; } catch { return false; } };

let VENV_PY = process.env.FRAMEWORKS_VENV;
const installFresh = !VENV_PY;
if (installFresh) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-fw-venv-')), 'venv');
  try { execFileSync('py', ['-3', '-m', 'venv', dir], { stdio: 'ignore' }); } catch { execFileSync('python', ['-m', 'venv', dir], { stdio: 'ignore' }); }
  VENV_PY = path.join(dir, 'Scripts', 'python.exe');
}

function get(url, ms = 60000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
  });
}
async function waitHttp(url, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await get(url, 5000);
    if (r.status || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
}

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${JSON.stringify(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${JSON.stringify(exe)})`, 'interpreter selected');
  await t.until(`ide.frameworks.info() && ide.util.samePath(ide.frameworks.info().root, ide.root)`, 'project inspected', 30000);
  await t.js('ide.frameworks.refresh().then(() => true)');
}

const card = (id) => `.inst-card[data-id="${id}"]`;
async function press(t, sel) {
  await t.until(`!!document.querySelector(${JSON.stringify(sel)})`, sel);
  await t.js(`(document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }), true)`);
  await t.click(sel);
}

// Puts the caret inside `needle` on the first line containing it (offset characters in) and focuses the editor.
async function caretAt(t, needle, offset = 2) {
  const pos = await t.js(`(() => {
    const m = ide.editor.getModel();
    const lines = m.getLinesContent();
    const i = lines.findIndex((l) => l.includes(${JSON.stringify(needle)}));
    if (i < 0) return null;
    const p = { lineNumber: i + 1, column: lines[i].indexOf(${JSON.stringify(needle)}) + 1 + ${offset} };
    ide.editor.setPosition(p);
    ide.editor.focus();
    return p;
  })()`);
  if (!pos) throw new Error(`no "${needle}" in the active editor`);
  return pos;
}
const activeRel = (t) => t.js(`ide.util.rel(ide.activeTab()?.path || '').replace(/\\\\/g, '/')`);
const activeLine = (t) => t.js(`ide.editor.getPosition().lineNumber`);
async function ctrlB(t, needle, want, label, offset = 2) {
  await caretAt(t, needle, offset);
  await t.press('Ctrl+B');
  try {
    await t.until(`ide.util.rel(ide.activeTab()?.path || '').replace(/\\\\/g, '/') === ${JSON.stringify(want.file)}${want.line ? ` && ide.editor.getPosition().lineNumber === ${want.line}` : ''}`, label, 8000);
    t.check(true, label);
  } catch {
    t.check(false, `${label} (at ${await activeRel(t)}:${await activeLine(t)})`);
  }
}
const completionLabels = (t) => t.js(`(async () => {
  const m = ide.editor.getModel();
  return (await ide.frameworks.templates.completions(m, ide.editor.getPosition())).map((s) => s.label);
})()`);
async function typeAtEnd(t, text) {
  await t.js(`(() => { const m = ide.editor.getModel(); const l = m.getLineCount(); ide.editor.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); ide.editor.focus(); return true; })()`);
  await t.type(text);
}
async function runTabText(t) { return t.js(`document.getElementById('runOut')?.innerText || ''`); }
const sessionRunning = (t, type) => t.js(`!!ide.run.sessions().find((s) => s.cfg.type === ${JSON.stringify(type)} && s.running)`);
async function setServerPort(t, type, port) {
  await t.js(`(() => { const c = ide.run.configs().find((x) => x.type === ${JSON.stringify(type)}); c.port = ${JSON.stringify(String(port))}; ide.run.select(c.id); return true; })()`);
}
async function stopAll(t) {
  await t.js(`(ide.run.sessions().forEach((s) => s.stop()), true)`);
  await t.until(`!ide.run.sessions().some((s) => s.running)`, 'servers stopped', 20000);
}

// ---------- Django ----------
{
  const t = await launch({ fixture: 'frameworks-django', port: 9740, name: 'frameworks-django' });
  const { js, until, press: key, type, check, shot, project } = t;
  try {
    await until('ide.currentInterp()', 'interpreter detected', 30000);
    await useInterpreter(t, VENV_PY);

    if (installFresh) {
      await js(`(ide.installer.open('Web Frameworks'), true)`);
      for (const pkg of PACKAGES) {
        await until(`!!document.querySelector('${card(`pip:${pkg}`)}') && !['unknown', 'checking'].includes(document.querySelector('${card(`pip:${pkg}`)}').dataset.phase)`, `${pkg} card checked`, 60000);
        await press(t, `${card(`pip:${pkg}`)} button[data-op="install"]`);
        await until(`document.querySelector('${card(`pip:${pkg}`)}')?.dataset.phase === 'installed'`, `${pkg} installed`, 300000);
      }
      check(imports(VENV_PY, PACKAGES), 'Django, Flask, FastAPI and uvicorn install into the fresh venv from the Install Manager (Web Frameworks)');
      await js(`(ide.closeTab('installer:manager', true), true)`);
    } else check(imports(VENV_PY, PACKAGES), 'FRAMEWORKS_VENV has Django, Flask, FastAPI and uvicorn');

    // ---------- detection ----------
    const info = await js('ide.frameworks.info()');
    check(JSON.stringify(await js('ide.frameworks.kinds()')) === '["django"]', 'manage.py + settings module: detected as a Django project (and not Flask/FastAPI)');
    check(info.django.settingsModule === 'mysite.settings' && info.django.rootUrlconf === 'mysite.urls', 'settings module and ROOT_URLCONF are read from manage.py and settings.py');
    const polls = info.django.apps.find((a) => a.name === 'polls');
    check(polls && polls.models.map((m) => m.name).join() === 'Question,Choice' && polls.models[1].fields.map((f) => `${f.name}:${f.type}`).join() === 'question:ForeignKey,choice_text:CharField,votes:IntegerField',
      'the polls app lists its models with their fields');
    check(polls?.admin.map((a) => `${a.model}/${a.admin}`).join() === 'Question/QuestionAdmin,Choice/null', '@admin.register and admin.site.register are both found');
    check(info.routes.map((r) => `${r.path}=${r.name}`).join() === '/polls/=polls:index,/polls/<int:question_id>/=polls:detail,/polls/<int:pk>/results/=polls:results,/admin/=null',
      'URL patterns are followed through include() with the app namespace');
    const cfgs = await js(`ide.run.configs().filter((c) => c.type === 'django-server').map((c) => ({ name: c.name, temporary: !!c.temporary }))`);
    check(cfgs.length === 1 && !cfgs[0].temporary && cfgs[0].name === 'project', 'a saved Django Server run configuration is created for the project');
    check(await js(`ide.run.selected()?.type === 'django-server'`), 'and selected, since nothing else was');

    // ---------- Django Structure ----------
    await js(`(ide.toolWindows.get('DjangoStructure').show(), true)`);
    const tree = await js(`document.getElementById('djangoStructure').innerText`);
    check(['polls', 'Models', 'Question', 'question_text', 'CharField', 'Admin', 'QuestionAdmin', 'URLs', '/polls/<int:question_id>/', 'mysite.settings'].every((s) => tree.includes(s)),
      'Django Structure shows apps, models with fields, admin, URLs and settings');
    await js(`[...document.querySelectorAll('#djangoStructure .fw-model')].find((n) => n.textContent.includes('Choice')).click()`);
    await until(`ide.activeTab()?.path.endsWith('models.py') && ide.editor.getPosition().lineNumber === 12`, 'Choice model opened');
    check(true, 'clicking a model opens models.py at the class');
    await shot('django-structure.png');

    // ---------- Endpoints ----------
    await js(`(ide.toolWindows.get('Endpoints').show(), true)`);
    check(await js(`document.querySelectorAll('#endpointsList .fw-endpoint').length`) === 4, 'Endpoints lists the four URL patterns');
    await js(`[...document.querySelectorAll('#endpointsList .fw-endpoint')].find((r) => r.dataset.path === '/polls/<int:question_id>/').click()`);
    await until(`ide.activeTab()?.path.endsWith('views.py') && ide.editor.getPosition().lineNumber === 13`, 'detail view opened');
    check(true, 'clicking an endpoint jumps to its view function');

    // ---------- manage.py task popup ----------
    await openFile(t, 'polls/models.py');
    await js('(ide.editor.focus(), true)');
    await key('Ctrl+Alt+R');
    await until(`[...document.querySelectorAll('#popupList .popup-item')].some((n) => n.textContent.includes('makemigrations'))`, 'manage.py commands listed', 60000);
    const listed = await js(`[...document.querySelectorAll('#popupList .popup-item')].map((n) => n.textContent)`);
    check(['check', 'migrate', 'runserver', 'shell', 'startapp'].every((c) => listed.some((l) => l.includes(c))), 'Ctrl+Alt+R lists the commands from manage.py help --commands');
    await type('makemig');
    await until(`[...document.querySelectorAll('#popupList .popup-item')].length >= 1 && [...document.querySelectorAll('#popupList .popup-item')][0].textContent.includes('makemigrations')`, 'filtered to makemigrations');
    await type(' polls');
    await until(`document.querySelector('#popupList .popup-item')?.textContent.includes('makemigrations polls')`, 'arguments kept');
    check(true, 'typing completes the command and keeps its arguments');
    await shot('manage-popup.png');
    await key('Enter');
    await until(`(document.getElementById('runOut')?.innerText || '').includes('Process finished with exit code')`, 'makemigrations finished', 60000);
    const mm = await runTabText(t);
    check(mm.includes("Migrations for 'polls'") && existsSync(path.join(project, 'polls', 'migrations', '0001_initial.py')), 'makemigrations polls runs in the Run tool window and writes the migration');
    await js(`(ide.runAction('Django.Migrate'), true)`);
    await until(`(document.getElementById('runOut')?.innerText || '').includes('Process finished with exit code')`, 'migrate finished', 90000);
    check((await runTabText(t)).includes('Applying polls.0001_initial... OK'), 'the Migrate action applies the migrations');

    // ---------- run the server ----------
    await setServerPort(t, 'django-server', 9745);
    await key('Shift+F10');
    const page = await waitHttp('http://127.0.0.1:9745/polls/', 60000);
    check(page.status === 200 && page.body.includes('HELLO FROM POLLS') && page.body.includes('class="item"'), 'Shift+F10 starts runserver and /polls/ answers 200 with the rendered template');
    check((await runTabText(t)).includes('runserver 127.0.0.1:9745') && await sessionRunning(t, 'django-server'), 'the Run tab shows the runserver command line');

    // ---------- gutter icons and the browser pane ----------
    await openFile(t, 'polls/views.py');
    await until(`ide.frameworks.views.gutterLines(ide.editor).length === 3`, 'view gutter icons');
    check(JSON.stringify(await js('ide.frameworks.views.gutterLines(ide.editor).sort((a, b) => a - b)')) === '[7,13,18]', 'view functions and the class-based view get a route gutter icon');
    await js(`(ide.editor.revealLine(7), true)`);
    await until(`!!document.querySelector('.editor-group .fw-route-gutter')`, 'gutter icon rendered');
    await t.click('.fw-route-gutter');
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((n) => n.textContent.includes('Open in Browser Pane'))`, 'route menu');
    await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.textContent.includes('Open in Browser Pane')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await until(`ide.activeTab()?.path === 'frameworks:browser' && ide.frameworks.browser()?.host.dataset.loaded`, 'browser pane loaded', 30000);
    // A cross-origin iframe runs out of process, so it is its own CDP target rather than a child in Page.getFrameTree.
    await until(`!!ide.frameworks.browser()`, 'browser pane');
    let urls = [];
    for (let i = 0; i < 40 && !urls.includes('http://127.0.0.1:9745/polls/'); i++) {
      urls = (await (await fetch('http://127.0.0.1:9740/json')).json()).filter((x) => x.type === 'iframe').map((x) => x.url);
      await t.sleep(250);
    }
    check(urls.includes('http://127.0.0.1:9745/polls/'), `the gutter icon opens /polls/ in the browser pane, framed despite X-Frame-Options: DENY (${urls.join(' ')})`);
    await shot('browser-pane.png');
    await stopAll(t);

    // ---------- breakpoint in a view ----------
    await openFile(t, 'polls/views.py');
    await caretAt(t, "greeting = 'Hello from polls'", 0);
    await js(`(ide.runAction('ToggleLineBreakpoint'), true)`);
    await js(`(ide.frameworks.runServer('django', { debug: true }), true)`);
    await until(`window.__debugger.state()?.state === 'running'`, 'debug session running', 60000);
    await waitHttp('http://127.0.0.1:9745/admin/login/', 60000);
    const pending = get('http://127.0.0.1:9745/polls/', 60000);
    await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith('views.py') && f.line === 9; })()`, 'suspended in the view', 30000);
    check(true, 'a breakpoint in the index view is hit when the page is requested under the debugger');
    await js(`(ide.runAction('Resume'), true)`);
    check((await pending).status === 200, 'after Resume the request completes with 200');
    await js(`(ide.runAction('StopDebug'), true)`);
    await until('window.__debugger.state() === null', 'debug session stopped', 20000);

    // ---------- templates ----------
    await openFile(t, 'polls/templates/polls/index.html');
    await until(`ide.editor.getModel().getLanguageId() === 'django-html'`, 'django template language');
    check(true, 'app templates open as Django templates');
    const toks = await js(`ide.monaco.editor.tokenize('{% extends "base.html" %}{{ greeting|upper }}{# note #}<p class="x">', 'django-html')[0].map((x) => x.type)`);
    check(toks[0].startsWith('keyword') && toks.some((x) => x.startsWith('string')) && toks.some((x) => x.startsWith('function')) && toks.some((x) => x.startsWith('comment')) && toks.some((x) => x.startsWith('tag')),
      `{% %}, {{ }}, filters, {# #} and HTML tags are highlighted (${[...new Set(toks)].join(' ')})`);
    await ctrlB(t, '"base.html"', { file: 'templates/base.html', line: 1 }, 'Ctrl+B on {% extends "base.html" %} opens the project template');
    await openFile(t, 'polls/templates/polls/index.html');
    await ctrlB(t, '"polls/_item.html"', { file: 'polls/templates/polls/_item.html', line: 1 }, 'Ctrl+B on {% include %} opens the app template');
    await openFile(t, 'polls/templates/polls/index.html');
    await ctrlB(t, "'polls:detail'", { file: 'polls/views.py', line: 13 }, "Ctrl+B on {% url 'polls:detail' %} opens the view");
    await openFile(t, 'polls/views.py');
    await ctrlB(t, "'polls/index.html'", { file: 'polls/templates/polls/index.html', line: 1 }, "Ctrl+B on render(request, 'polls/index.html') opens the template");
    await openFile(t, 'polls/views.py');
    await caretAt(t, 'get_object_or_404(Question', 4);
    check(await js(`ide.actions.find((a) => a.id === 'Frameworks.GotoDeclaration').when() === false`), 'on a Python name Ctrl+B is left to Pyright');
    await openFile(t, 'mysite/urls.py');
    await ctrlB(t, "'polls.urls'", { file: 'polls/urls.py', line: 1 }, "Ctrl+B on include('polls.urls') opens the app's urls.py");
    await ctrlB(t, "'<int:question_id>/'", { file: 'polls/views.py', line: 13 }, 'Ctrl+B on a urls.py pattern opens its view');
    await openFile(t, 'polls/urls.py');
    await ctrlB(t, "'<int:pk>/results/'", { file: 'polls/views.py', line: 18 }, 'a class-based view pattern opens the class');

    await openFile(t, 'polls/templates/polls/index.html');
    await caretAt(t, '{% endblock %}', 0);
    await type('{% ');
    const tags = await completionLabels(t);
    check(tags[0] === 'endblock' && ['for', 'if', 'include', 'url', 'csrf_token', 'poll_count'].every((x) => tags.includes(x)), `tag completion offers endblock first, the built-in tags and {% load %}ed custom tags (${tags.slice(0, 5).join(', ')}…)`);
    await t.js(`(ide.editor.trigger('keyboard', 'editor.action.triggerSuggest', {}), true)`);
    await until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].some((r) => r.textContent.includes('endblock'))`, 'suggest widget', 10000);
    check(true, 'the suggest widget shows template tags while typing {% ');
    await key('Escape');
    await type('include "');
    const names = await completionLabels(t);
    check(['base.html', 'polls/_item.html', 'polls/detail.html'].every((x) => names.includes(x)) && !names.includes('polls/index.html'), 'template names complete inside {% include "…" %}');
    await typeAtEnd(t, '" %}\n{{ greeting|');
    const filters = await completionLabels(t);
    check(['upper', 'date', 'default', 'truncatewords', 'shout'].every((x) => filters.includes(x)), 'filters complete after |, including the project filter from poll_extras');
    await typeAtEnd(t, 'upper }}\n{% url "');
    const urlNames = await completionLabels(t);
    check(['polls:index', 'polls:detail', 'polls:results'].every((x) => urlNames.includes(x)), 'URL names complete inside {% url "…" %}');
    await typeAtEnd(t, 'polls:index" %}\n{% block ');
    check((await completionLabels(t)).join() === 'title,content', 'block names come from the extended template');
    await shot('template.png');
  } catch (err) {
    check(false, err.message);
    await shot('django-failure.png').catch(() => {});
  }
  await t.close();
  var djangoResults = t.results;
  var djangoErrors = t.consoleErrors;
}

// ---------- Flask ----------
{
  const t = await launch({ fixture: 'frameworks-flask', port: 9741, name: 'frameworks-flask' });
  const { js, until, press: key, check, shot } = t;
  try {
    await until('ide.currentInterp()', 'interpreter detected', 30000);
    await useInterpreter(t, VENV_PY);
    check(JSON.stringify(await js('ide.frameworks.kinds()')) === '["flask"]', 'an app factory with Flask(__name__): detected as a Flask project');
    const routes = await js(`ide.frameworks.info().routes.map((r) => r.methods.join('|') + ' ' + r.path + ' ' + r.name)`);
    check(routes.join(', ') === 'GET / index, GET /hello/<name> hello, GET|POST /auth/login auth.login, GET /auth/logout auth.logout', `routes include blueprint prefixes and endpoints (${routes.join(', ')})`);
    check(await js(`ide.run.configs().find((c) => c.type === 'flask-server')?.target`) === 'flaskr', 'the Flask Server configuration targets the flaskr package');

    await js(`(ide.toolWindows.get('Endpoints').show(), true)`);
    const rows = await js(`[...document.querySelectorAll('#endpointsList .fw-endpoint')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
    check(rows.length === 4 && rows[2].startsWith('GET, POST /auth/login auth.login auth.py:7'), `Endpoints shows method, path, endpoint and source (${rows[2]})`);
    await js(`(() => { const f = document.querySelector('.fw-filter'); f.value = 'auth'; f.dispatchEvent(new Event('input')); return true; })()`);
    check(await js(`document.querySelectorAll('#endpointsList .fw-endpoint').length`) === 2, 'the filter narrows the list');
    await js(`document.querySelector('#endpointsList .fw-endpoint').click()`);
    await until(`ide.activeTab()?.path.endsWith('auth.py') && ide.editor.getPosition().lineNumber === 7`, 'login view opened');
    check(true, 'clicking a route jumps to the view');
    await shot('endpoints.png');

    await setServerPort(t, 'flask-server', 9746);
    await key('Shift+F10');
    const home = await waitHttp('http://127.0.0.1:9746/', 60000);
    check(home.status === 200 && home.body.includes('<h1>Flask fixture</h1>') && home.body.includes('href="/auth/login"'), 'flask run serves / with 200 and the rendered Jinja2 template');
    check((await get('http://127.0.0.1:9746/auth/login')).status === 200, 'the blueprint route answers 200 too');
    check((await t.js(`document.getElementById('runOut')?.innerText || ''`)).includes('-m flask run --host 127.0.0.1 --port 9746 --reload'), 'the run uses flask run with the reloader');
    await stopAll(t);

    await openFile(t, 'flaskr/templates/index.html');
    await until(`ide.editor.getModel().getLanguageId() === 'jinja2'`, 'jinja2 language');
    check(true, 'Flask templates open as Jinja2');
    await ctrlB(t, "'base.html'", { file: 'flaskr/templates/base.html', line: 1 }, "Ctrl+B on {% extends 'base.html' %} in Jinja2");
    await ctrlB(t, "'auth.login'", { file: 'flaskr/auth.py', line: 7 }, "Ctrl+B on url_for('auth.login') opens the blueprint view");
    await openFile(t, 'flaskr/__init__.py');
    await ctrlB(t, "'index.html'", { file: 'flaskr/templates/index.html', line: 1 }, "Ctrl+B on render_template('index.html') opens the template");
    await openFile(t, 'flaskr/templates/index.html');
    await typeAtEnd(t, '\n{{ title|');
    const filters = await completionLabels(t);
    check(['title', 'tojson', 'default', 'truncate'].every((x) => filters.includes(x)) && !filters.includes('linebreaksbr'), 'Jinja2 filters complete after |');
    await typeAtEnd(t, 'title }}\n{{ url_for("');
    check((await completionLabels(t)).includes('auth.login'), 'url_for completes Flask endpoints');
    await typeAtEnd(t, 'auth.login") }}\n{% ');
    const tags = await completionLabels(t);
    check(['macro', 'set', 'for', 'call'].every((x) => tags.includes(x)) && !tags.includes('csrf_token'), 'Jinja2 tag completion');
    await openFile(t, 'flaskr/auth.py');
    await until(`ide.frameworks.views.gutterLines(ide.editor).length === 2`, 'flask gutter icons');
    check(true, 'Flask view functions get route gutter icons');
  } catch (err) {
    check(false, err.message);
    await shot('flask-failure.png').catch(() => {});
  }
  await t.close();
  var flaskResults = t.results;
  var flaskErrors = t.consoleErrors;
}

// ---------- FastAPI ----------
{
  const t = await launch({ fixture: 'frameworks-fastapi', port: 9742, name: 'frameworks-fastapi' });
  const { js, until, check, shot } = t;
  try {
    await until('ide.currentInterp()', 'interpreter detected', 30000);
    await useInterpreter(t, VENV_PY);
    check(JSON.stringify(await js('ide.frameworks.kinds()')) === '["fastapi"]', 'app = FastAPI(): detected as a FastAPI project');
    const routes = await js(`ide.frameworks.info().routes.map((r) => r.methods.join('|') + ' ' + r.path)`);
    check(routes.join(', ') === 'GET /, POST /echo, GET /api/items/{item_id}, WS /api/items/ws', `include_router and APIRouter prefixes combine (${routes.join(', ')})`);
    check(await js(`ide.run.configs().find((c) => c.type === 'fastapi-server')?.target`) === 'main:app', 'the FastAPI configuration targets main:app');
    await setServerPort(t, 'fastapi-server', 9747);
    await js(`(ide.runAction('Run'), true)`);
    const root = await waitHttp('http://127.0.0.1:9747/', 60000);
    check(root.status === 200 && JSON.parse(root.body).message === 'Hello World', 'uvicorn serves / with 200');
    const item = await get('http://127.0.0.1:9747/api/items/5');
    check(item.status === 200 && JSON.parse(item.body).item_id === 5, 'the router route answers 200');
    check((await t.js(`document.getElementById('runOut')?.innerText || ''`)).includes('-m uvicorn main:app --host 127.0.0.1 --port 9747 --reload'), 'the run uses uvicorn with --reload');
    await openFile(t, 'routers/items.py');
    await until(`ide.frameworks.views.gutterLines(ide.editor).length === 2`, 'fastapi gutter icons');
    await js(`(ide.frameworks.openRoute(ide.frameworks.info().routes.find((r) => r.path === '/api/items/{item_id}')), true)`);
    await until(`ide.frameworks.browser()?.address.value === 'http://127.0.0.1:9747/api/items/1'`, 'route url with a sample parameter');
    check(true, 'opening a route with {item_id} fills in a sample value');
    await stopAll(t);
  } catch (err) {
    check(false, err.message);
    await shot('fastapi-failure.png').catch(() => {});
  }
  await t.close();
  var fastapiResults = t.results;
  var fastapiErrors = t.consoleErrors;
}

// ---------- Korean UI ----------
{
  const t = await launch({ fixture: 'frameworks-django', port: 9743, name: 'frameworks-ko', lang: 'ko-KR' });
  const { js, until, press: key, check, shot } = t;
  try {
    await until('ide.currentInterp()', 'interpreter detected', 30000);
    await useInterpreter(t, VENV_PY);
    const leaks = [];
    await js(`(ide.toolWindows.get('DjangoStructure').show(), true)`);
    leaks.push(...await englishLeaks(t, '#sidePanel, #djangoStructure'));
    await js(`(ide.toolWindows.get('Endpoints').show(), true)`);
    leaks.push(...await englishLeaks(t, '#bottom'));
    await shot('ko-tools.png');
    await openFile(t, 'polls/views.py');
    await until(`ide.frameworks.views.gutterLines(ide.editor).length === 3`, 'gutter icons');
    await js(`(ide.editor.revealLine(7), true)`);
    await until(`!!document.querySelector('.editor-group .fw-route-gutter')`, 'gutter icon rendered');
    await t.click('.fw-route-gutter');
    await until(`!!document.querySelector('.context-menu')`, 'route menu');
    leaks.push(...await englishLeaks(t, '.context-menu'));
    await key('Escape');
    await js('(ide.editor.focus(), true)');
    await key('Ctrl+Alt+R');
    await until(`!!document.querySelector('#popupList .popup-item')`, 'manage.py popup', 60000);
    leaks.push(...await englishLeaks(t, '#popup'));
    await key('Escape');
    await js(`(ide.run.editConfigurations(ide.run.configs().find((c) => c.type === 'django-server').id), true)`);
    await until(`!!document.querySelector('.rc-form input[data-key="reload"]')`, 'configuration form');
    leaks.push(...await englishLeaks(t, '.dialog'));
    await shot('ko-config.png');
    await js(`(document.querySelector('.dialog .secondary, .dialog button').click(), true)`);
    await js(`(ide.installer.open(tr('Web Frameworks')), true)`);
    await until(`!!document.querySelector('${card('pip:django')}')`, 'Web Frameworks category');
    leaks.push(...await englishLeaks(t, '.inst-cards, .inst-side', ['Django', 'Flask', 'FastAPI', 'Uvicorn', 'Jinja2', 'WSGI', 'ASGI']));
    check(!leaks.length, `Korean UI has no English leaks${leaks.length ? `: ${JSON.stringify(leaks.slice(0, 8))}` : ''}`);
    const mine = new Set(['index.js', 'templates.js', 'views.js'].flatMap((f) => [...readFileSync(path.join(PLUGIN, f), 'utf8').matchAll(/\btr\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))));
    const ko = JSON.parse(readFileSync(path.join(PLUGIN, 'locales', 'ko.json'), 'utf8'));
    const missing = [...new Set([...(await missingTranslations(t)).filter((s) => mine.has(s)), ...[...mine].filter((s) => !ko[s])])];
    check(!missing.length, `every frameworks string has a Korean translation${missing.length ? `: ${JSON.stringify(missing)}` : ''}`);
  } catch (err) {
    check(false, err.message);
    await shot('ko-failure.png').catch(() => {});
  }
  t.results.unshift(...djangoResults, ...flaskResults, ...fastapiResults);
  t.consoleErrors.unshift(...djangoErrors, ...flaskErrors, ...fastapiErrors);
  t.finish();
}
