// HTML preview of server-side pages: a Spring Boot (Thymeleaf) page gets its th:href stylesheet from
// src/main/resources/static and its th:replace fragments from templates/, and a Flask (Jinja2) template keeps its
// template editor while Preview Template (its button, its action) shows it beside, put together from {% extends %},
// {% block %} and {% include %}, with url_for('static', ...) found in the app's static folder and the values the server
// fills in left empty. The pages report what they see with postMessage (their frames are cross-origin to the IDE).
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { renderTemplate, renderThymeleaf } from '../main/template-preview.js';

const PROBE = `<script>addEventListener('load', () => {
  const h1 = document.querySelector('h1');
  parent.postMessage({ probe: true, h1: h1 && getComputedStyle(h1).color, text: document.body.innerText.replace(/\\s+/g, ' ').trim(),
    nav: !!document.querySelector('nav a') }, '*');
});</script>`;

const t = await launch({ fixture: 'core', port: 9852, name: 'html-preview-templates' });
const { js, until, check } = t;
const q = JSON.stringify;
const w = (rel, text) => { mkdirSync(path.dirname(path.join(t.project, rel)), { recursive: true }); writeFileSync(path.join(t.project, rel), text); };
try {
  // Pure checks of the renderer: an extends chain with block.super, a missing parent, a loop that extends itself.
  const files = { 'a.html': '{% extends "b.html" %}{% block x %}A{{ block.super }}{% endblock %}', 'b.html': '{% extends "c.html" %}', 'c.html': '<p>{% block x %}C{% endblock %}</p>{# gone #}' };
  check(await renderTemplate(files['a.html'], { load: async (n) => files[n] ?? null }) === '<p>AC</p>', 'blocks override through two levels of extends, with block.super');
  check(await renderTemplate('{% extends "none.html" %}<b>{{ x }}</b>', { load: async () => null }) === '<b></b>', 'a missing parent leaves the page as it is, values empty');
  check(typeof await renderTemplate('{% extends "self.html" %}', { load: async () => '{% extends "self.html" %}' }) === 'string', 'a template that extends itself stops');
  const urls = await renderTemplate(`{{ url_for('static', path='/css/a.css') }}|{{ request.url_for('static', path='b.css') }}|{{ url_for('admin.static', filename='c.png') }}`, { load: async () => null });
  check(urls === '/static/css/a.css|/static/b.css|/static/c.png', `FastAPI's path= and a blueprint's static become /static/... (${urls})`);
  const lib = { 'fragments/layout.html': '<div><header th:fragment="header(t)"><b>Top</b></header><footer th:fragment="footer">Bottom</footer><p id="note">Note</p></div>' };
  const th = await renderThymeleaf(`<html xmlns:th="http://www.thymeleaf.org"><head><link th:href="@{/css/a.css(v=\${v})}"><link th:href="@{/b.css}" href="/kept.css"></head>
<body><div th:replace="~{fragments/layout :: header('x')}">old</div><section th:insert="fragments/layout :: footer">old</section><span th:include="~{fragments/layout :: #note}"/><i th:replace="~{none :: x}">kept</i><p th:if="\${n > 0}">ok</p></body></html>`,
  { load: async (n) => lib[n] ?? null });
  check(th.includes('href="/css/a.css"') && th.includes('href="/kept.css"') && !th.includes('href="/b.css"'), 'th:href gives a link only where the tag has no href');
  check(th.includes('<header th:fragment="header(t)"><b>Top</b></header>') && !th.includes('>old<'), 'th:replace puts the fragment in place of its host');
  check(th.includes('<section><footer th:fragment="footer">Bottom</footer></section>') && th.includes('<span>Note</span>'), 'th:insert keeps its host around the fragment, th:include takes the fragment\'s content');
  check(th.includes('<i>kept</i>') && th.includes('<p th:if="${n > 0}">ok</p>'), 'a fragment that is not found keeps its placeholder, and > inside an attribute stays in its tag');

  await js(`(window.__probes = [], addEventListener('message', (e) => { if (e.data?.probe) window.__probes.push(e.data); }), true)`);
  const nextProbe = async (label) => {
    const n = await js(`window.__probes.length`);
    await until(`window.__probes.length > ${n}`, label, 20000);
    return js(`window.__probes.at(-1)`);
  };

  // ---------- Spring Boot ----------
  w('pom.xml', '<project><artifactId>demo</artifactId></project>\n');
  w('src/main/resources/static/css/site.css', 'h1 { color: rgb(200, 30, 30); }\n');
  w('src/main/resources/templates/fragments/layout.html', `<html xmlns:th="http://www.thymeleaf.org"><body>
<nav th:fragment="nav"><a th:href="@{/}">Shop home</a></nav>
</body></html>
`);
  w('src/main/resources/templates/menu.html', `<!doctype html>
<html xmlns:th="http://www.thymeleaf.org"><head><meta charset="utf-8">
<link rel="stylesheet" th:href="@{/css/site.css}">
</head><body><div th:replace="~{fragments/layout :: nav}">nav here</div><h1 th:text="\${title}">Menu</h1>${PROBE}</body></html>
`);
  let p = nextProbe('Spring page loaded');
  await openFile(t, 'src/main/resources/templates/menu.html');
  await until(`!!document.querySelector('.vw-html .vw-html-frame')`, 'HTML viewer for the Spring page');
  const spring = await p;
  check(spring.h1 === 'rgb(200, 30, 30)', `a Spring Boot page's th:href="@{/css/site.css}" comes from src/main/resources/static (${spring.h1})`);
  check(spring.nav && spring.text.includes('Shop home') && !spring.text.includes('nav here'), `th:replace puts in the fragment from templates/fragments (${q(spring.text)})`);

  // ---------- Flask ----------
  w('shop/__init__.py', 'from flask import Flask\n\napp = Flask(__name__)\n');
  w('shop/static/css/app.css', 'h1 { color: rgb(0, 128, 0); }\n');
  w('shop/templates/base.html', `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="{{ url_for('static', filename='css/app.css') }}"></head>
<body>{% include '_nav.html' %}<main>{% block content %}Base content{% endblock %}</main>${PROBE}</body></html>
`);
  w('shop/templates/_nav.html', `<nav>{% for item in menu %}<a href="{{ url_for('index') }}">{{ item }}</a>{% endfor %}<a href="#">Home</a></nav>\n`);
  w('shop/templates/index.html', `{% extends 'base.html' %}
{% block content %}<h1>Today: {{ title }}</h1><p>Child block</p>{% endblock %}
`);
  const index = path.join(t.project, 'shop', 'templates', 'index.html');
  await js(`ide.frameworks.refresh()`);
  await until(`ide.frameworks.templateLanguage(${q(index)}) === 'jinja2'`, 'Flask templates known', 60000);
  await openFile(t, 'shop/templates/index.html');
  await until(`ide.activeTab()?.kind === 'file' && ide.editor.getModel()?.getLanguageId() === 'jinja2'`, 'template editor');
  check(true, 'a Flask template still opens in the Jinja2 editor');
  check(await js(`(ide.editorMenuActions(ide.editor) || []).some((a) => a.id === 'viewers.previewTemplate')`), 'the editor context menu offers Preview Template');

  check(await js(`ide.actions.some((a) => a.id === 'Viewers.PreviewTemplate' && a.when())`), 'Preview Template is an action for Find Action');
  await until(`!!document.querySelector('.vw-template-preview-btn:not(.hidden)')`, 'preview button on the template editor');
  check(true, 'the template editor shows a Preview button in its top right corner');
  p = nextProbe('template preview loaded');
  await t.click('.vw-template-preview-btn:not(.hidden)');
  await until(`ide.activeTab()?.path === ${q(`template-preview:${index}`)}`, 'Preview Template tab');
  const first = await p;
  check(first.h1 === 'rgb(0, 128, 0)', `url_for('static', ...) finds shop/static/css/app.css (${first.h1})`);
  check(first.text.includes('Today:') && first.text.includes('Child block') && !first.text.includes('Base content'), `the child's block replaces the base's (${q(first.text)})`);
  check(first.nav && first.text.includes('Home') && !first.text.includes('{'), `{% include %} is inlined and values are left empty (${q(first.text)})`);
  const note = await js(`ide.findTab(${q(`template-preview:${index}`)}).host.querySelector('.vw-html-template')?.textContent || ''`);
  check(note === 'Template preview: what the server fills in is left empty', `the preview's toolbar says it is a template preview (${q(note)})`);
  check(await js(`ide.groups().length === 2 && ide.groups()[1].tabs.some((x) => x.path.startsWith('template-preview:'))`), 'the preview opens beside the template');

  p = nextProbe('preview after an unsaved edit');
  await js(`(() => { const tab = ide.findTab(${q(index)}); const m = tab.doc.model; m.setValue(m.getValue().replace('Child block', 'Edited block')); return true; })()`);
  check((await p).text.includes('Edited block'), 'an unsaved edit of the template shows in its preview');

  await js(`(ide.closeTab(${q(index)}, true), true)`);
  await until(`!ide.findTab(${q(`template-preview:${index}`)})`, 'preview closed with its template', 10000).catch(() => {});
  check(!(await js(`!!ide.findTab(${q(`template-preview:${index}`)})`)), 'closing the template closes its preview');
} finally {
  await t.finish();
}
