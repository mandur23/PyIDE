// File and Code Templates (PyCharm's Settings › Editor › File and Code Templates, Files tab). A template has a name, an
// extension and a text with variables: ${NAME} (the new file's name without its extension), ${USER}, ${DATE}
// (yyyy-mm-dd), ${TIME} (HH:mm), ${YEAR}, ${MONTH}, ${DAY}, ${HOUR}, ${MINUTE}, ${PROJECT_NAME}, ${PACKAGE_NAME} (the
// folder's dotted path from the project root), ${PRODUCT_NAME} and ${DS} (a dollar sign); `$NAME` without braces works
// for these names, and `\$` is a literal dollar. Any other ${VARIABLE} is asked for in a dialog when a file is
// created, as in PyCharm. The project tree's New submenu creates files from them; core's New Python File (Alt+Insert,
// toolbar, File menu) takes the "Python Script" template through ide.newFileHooks, and a package's __init__.py takes
// "Python Package". Templates are IDE-level: `fileTemplates.custom` = {name: {ext?, body?}} holds edits of built-ins
// (reset by deleting them) and user templates; Settings export carries it (main/settings-sync/archive.js).
(() => {
  const { el, basename, dirname, joinPath } = ide.util;
  const CUSTOM = 'fileTemplates.custom';
  const SCRIPT = 'Python Script';
  const PACKAGE = 'Python Package';
  const BUILTIN = [
    // PyCharm's Python Script template is empty; users put their file header here.
    { name: SCRIPT, ext: 'py', body: '' },
    { name: PACKAGE, ext: 'py', body: '', package: true },
    { name: 'Python Unit Test', ext: 'py', body: 'import unittest\n\n\nclass MyTestCase(unittest.TestCase):\n    def test_something(self):\n        self.assertEqual(True, False)  # add assertion here\n\n\nif __name__ == \'__main__\':\n    unittest.main()\n' },
    { name: 'HTML File', ext: 'html', body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <title>${NAME}</title>\n</head>\n<body>\n\n</body>\n</html>\n' },
    { name: 'JSON File', ext: 'json', body: '{\n}\n' },
    { name: 'Markdown File', ext: 'md', body: '# ${NAME}\n' },
    { name: 'Text File', ext: 'txt', body: '' },
  ];
  const BUILTIN_BY_NAME = new Map(BUILTIN.map((t) => [t.name, t]));
  // Built-in names are shown translated; user templates keep the name the user typed.
  const NAMES = { [SCRIPT]: () => tr('Python Script'), [PACKAGE]: () => tr('Python Package'), 'Python Unit Test': () => tr('Python Unit Test'),
    'HTML File': () => tr('HTML File'), 'JSON File': () => tr('JSON File'), 'Markdown File': () => tr('Markdown File'), 'Text File': () => tr('Text File') };
  const displayName = (t) => NAMES[t.name]?.() || t.name;
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const NAME_OK = (n) => typeof n === 'string' && !!n.trim() && n.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(n);
  const EXT_OK = /^[A-Za-z0-9_.-]{0,20}$/;

  // Built-ins with the user's edits, then user templates: [{name, ext, body, builtin, modified, package?}].
  function merge(custom = ide.settings.get(CUSTOM, {})) {
    const c = plain(custom) ? custom : {};
    const out = BUILTIN.map((b) => {
      const o = plain(c[b.name]) ? c[b.name] : {};
      const body = typeof o.body === 'string' ? o.body : b.body;
      const ext = typeof o.ext === 'string' && EXT_OK.test(o.ext) ? o.ext : b.ext;
      return { ...b, body, ext, builtin: true, modified: body !== b.body || ext !== b.ext };
    });
    for (const [name, o] of Object.entries(c)) {
      if (BUILTIN_BY_NAME.has(name) || !NAME_OK(name) || !plain(o)) continue;
      out.push({ name, ext: typeof o.ext === 'string' && EXT_OK.test(o.ext) ? o.ext : '', body: typeof o.body === 'string' ? o.body : '', builtin: false, modified: false });
    }
    return out;
  }
  const templates = () => merge();
  const find = (name) => templates().find((t) => t.name === name) || null;

  // ---------- variables ----------
  let userName = null;
  const user = async () => (userName ??= await ide.api.invoke('file-templates:user').catch(() => ''));
  const pad = (n) => String(n).padStart(2, '0');
  async function builtinVars(path, { name } = {}) {
    const now = new Date();
    const dir = dirname(path);
    const relDir = ide.root && ide.util.isUnder(dir, ide.root) ? ide.util.rel(dir) : '';
    return {
      NAME: name ?? basename(path).replace(/\.[^.]*$/, ''),
      USER: await user(),
      DATE: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      TIME: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      YEAR: String(now.getFullYear()),
      MONTH: pad(now.getMonth() + 1),
      DAY: pad(now.getDate()),
      HOUR: pad(now.getHours()),
      MINUTE: pad(now.getMinutes()),
      PROJECT_NAME: ide.root ? basename(ide.root) : '',
      PACKAGE_NAME: relDir && !ide.util.samePath(dir, ide.root) ? relDir.split(/[\\/]/).filter(Boolean).join('.') : '',
      PRODUCT_NAME: 'PyIDE',
      DS: '$',
    };
  }
  const VAR = /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
  // The variables the text uses that are not built in (asked for when a file is created).
  const unknownVars = (body, vars) => [...new Set([...body.matchAll(VAR)].map((m) => m[1]).filter((v) => v && !(v in vars)))];
  const substitute = (body, vars) => body.replace(VAR, (m, braced, bare) => {
    if (m === '\\$') return '$';
    const v = braced ?? bare;
    return v in vars ? vars[v] : m;
  });

  // Asks for the values of custom variables; resolves null when cancelled.
  function askVars(names, templateName) {
    return new Promise((resolve) => {
      let values = null;
      const body = el('div', 'ft-vars');
      const inputs = names.map((n) => {
        const row = el('label', 'ft-var-row');
        const input = el('input', 'input');
        input.dataset.var = n;
        row.append(el('span', null, n), input);
        body.append(row);
        return input;
      });
      ide.ui.dialog({
        title: tr('Template variables: {name}', { name: templateName }),
        body,
        width: 440,
        onClose: () => resolve(values),
        buttons: [
          { label: tr('OK'), primary: true, run: () => { values = Object.fromEntries(names.map((n, i) => [n, inputs[i].value])); } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // The text for a new file at `path` from a template; null when the variable dialog was cancelled.
  async function render(template, path, extra = {}) {
    const t = typeof template === 'string' ? find(template) : template;
    if (!t) return '';
    const vars = { ...(await builtinVars(path, extra)), ...(extra.vars || {}) };
    const missing = unknownVars(t.body, vars);
    if (missing.length) {
      const asked = await askVars(missing, displayName(t));
      if (!asked) return null;
      Object.assign(vars, asked);
    }
    return substitute(t.body, vars);
  }

  // ---------- creating files ----------
  const exists = (p) => ide.api.exists(p);
  async function writeNew(target, text) {
    await ide.api.create(target, false);
    if (text) await ide.api.write(target, text);
  }
  async function finish(target, created) {
    await ide.refreshTree();
    ide.emit('filesChanged', { created });
    await ide.revealInTree?.(target);
    await ide.openFile(target);
  }
  // Creates a file (or a package) in `dir` from a template. fileName skips the name prompt (tests, other plugins).
  async function create(templateName, dir, fileName) {
    const t = templateName ? find(templateName) : null;
    if (templateName && !t) return null;
    const name = fileName ?? await ide.ui.prompt(t?.package ? tr('New Python package name') : t ? tr('Name for the new {template}', { template: displayName(t) }) : tr('New file name'), '');
    if (!name || !name.trim()) return null;
    try {
      if (t?.package) {
        // a.b creates the package b inside a (also a package), as PyCharm does. The template's variables are asked for
        // before anything is created, so Cancel leaves no folders behind.
        const parts = name.trim().split('.').filter(Boolean);
        const folders = [];
        for (const part of parts) folders.push(joinPath(folders[folders.length - 1] || dir, part));
        const init = joinPath(folders[folders.length - 1], '__init__.py');
        if (await exists(init)) { ide.ui.alert(tr('{path} already exists', { path: parts.join('.') })); return null; }
        const text = await render(t, init, { name: parts[parts.length - 1] });
        if (text === null) return null;
        const created = [];
        for (const folder of folders) {
          if (!(await exists(folder))) { await ide.api.create(folder, true); created.push(folder); }
        }
        await writeNew(init, text);
        await finish(init, [...created, init]);
        return init;
      }
      const file = t?.ext && !basename(name).includes('.') ? `${name.trim()}.${t.ext}` : name.trim();
      const target = joinPath(dir, file);
      if (await exists(target)) { ide.ui.alert(tr('{path} already exists', { path: basename(target) })); return null; }
      const text = t ? await render(t, target) : '';
      if (text === null) return null;
      await writeNew(target, text);
      await finish(target, [target]);
      return target;
    } catch (e) {
      ide.ui.alert(ide.util.errorText(e));
      return null;
    }
  }

  // Core's New Python File: the Python Script template.
  ide.newFileHooks?.push(async (path) => (/\.pyw?$/i.test(path) ? render(SCRIPT, path) : undefined));

  // Project tree › New ›
  const dirOf = (entry) => (!entry ? ide.root : entry.dir ? entry.path : dirname(entry.path));
  ide.treeNewItems?.push((entry) => {
    if (!ide.root) return [];
    const dir = dirOf(entry);
    return [{ label: tr('New'), submenu: () => {
      const all = templates();
      const others = all.filter((t) => t.name !== SCRIPT && t.name !== PACKAGE);
      return [
        { label: tr('File'), run: () => create(null, dir) },
        { label: tr('Python File'), run: () => create(SCRIPT, dir) },
        { label: tr('Python Package'), run: () => create(PACKAGE, dir) },
        { separator: true },
        ...others.map((t) => ({ label: displayName(t), detail: t.ext ? `.${t.ext}` : '', run: () => create(t.name, dir) })),
        { separator: true },
        { label: tr('Edit File Templates…'), run: () => ide.openSettings?.('file-templates') },
      ];
    } }];
  });

  // ---------- Settings › Editor › File and Code Templates ----------
  const VAR_HELP = () => [
    ['${NAME}', tr('the name of the new file, without its extension')],
    ['${USER}', tr('your user name')],
    ['${DATE}', tr('the current date (yyyy-mm-dd)')],
    ['${TIME}', tr('the current time (HH:mm)')],
    ['${YEAR} ${MONTH} ${DAY} ${HOUR} ${MINUTE}', tr('parts of the current date and time')],
    ['${PROJECT_NAME}', tr('the name of the project')],
    ['${PACKAGE_NAME}', tr('the folder of the new file as a dotted package name')],
    ['${DS}', tr('a dollar sign')],
  ];
  function mountPage(host, ctx) {
    const custom = structuredClone(plain(ctx.value(CUSTOM)) ? ctx.value(CUSTOM) : {});
    const save = () => {
      for (const [name, c] of Object.entries(custom)) if (BUILTIN_BY_NAME.has(name) && !Object.keys(c).length) delete custom[name];
      ctx.set(CUSTOM, structuredClone(custom));
    };
    let selected = SCRIPT;
    const s = ctx.ui.section(host, tr('Files'));
    const root = el('div', 'ft-page');
    const bar = el('div', 'ft-toolbar');
    const btn = (cls, text, title, run) => { const b = el('button', `secondary ${cls}`, text); b.title = title; b.onclick = run; bar.appendChild(b); return b; };
    const list = el('div', 'ft-list');
    const form = el('div', 'ft-form');
    root.append(bar, list, form);
    s.appendChild(root);

    const nameIn = el('input', 'ft-name');
    const extIn = el('input', 'ft-ext');
    const bodyIn = el('textarea', 'ft-body');
    bodyIn.spellcheck = false;
    bodyIn.rows = 10;
    const row = (label, control) => { const r = el('label', 'ft-field'); r.append(el('span', null, label), control); return r; };
    const help = el('div', 'ft-help');
    help.append(el('div', 'muted', tr('Predefined variables (any other ${VARIABLE} is asked for when the file is created):')));
    for (const [v, text] of VAR_HELP()) { const r = el('div', 'ft-help-row'); r.append(el('code', null, v), el('span', 'muted', text)); help.append(r); }
    form.append(row(tr('Name'), nameIn), row(tr('Extension'), extIn), row(tr('Template text'), bodyIn), help);

    const current = () => merge(custom).find((t) => t.name === selected);
    const entry = (name) => (custom[name] ||= {});
    btn('ft-add', '+', tr('Create Template'), () => {
      let n = 1;
      while (merge(custom).some((t) => t.name === `Unnamed${n > 1 ? n : ''}`)) n++;
      const name = `Unnamed${n > 1 ? n : ''}`;
      custom[name] = { ext: 'py', body: '' };
      selected = name;
      save();
      render();
      nameIn.focus();
      nameIn.select();
    });
    const removeBtn = btn('ft-remove', '−', tr('Remove Template'), () => {
      const t = current();
      if (!t || t.builtin) return;
      delete custom[t.name];
      selected = SCRIPT;
      save();
      render();
    });
    const resetBtn = btn('ft-reset', tr('Reset to Default'), tr('Restore the built-in template'), () => {
      const t = current();
      if (!t?.builtin) return;
      delete custom[t.name];
      save();
      render();
    });

    nameIn.onchange = () => {
      const t = current();
      const v = nameIn.value.trim();
      const ok = NAME_OK(v) && (v === t.name || !merge(custom).some((x) => x.name === v));
      nameIn.classList.toggle('invalid', !ok);
      if (!ok || t.builtin || v === t.name) return;
      custom[v] = custom[t.name];
      delete custom[t.name];
      selected = v;
      save();
      renderList();
    };
    extIn.oninput = () => {
      const t = current();
      const v = extIn.value.trim().replace(/^\./, '');
      const ok = EXT_OK.test(v);
      extIn.classList.toggle('invalid', !ok);
      if (!ok) return;
      if (t.builtin && v === BUILTIN_BY_NAME.get(t.name).ext) delete entry(t.name).ext; else entry(t.name).ext = v;
      save();
      renderList();
      resetBtn.disabled = !current().modified;
    };
    bodyIn.oninput = () => {
      const t = current();
      if (t.builtin && bodyIn.value === BUILTIN_BY_NAME.get(t.name).body) delete entry(t.name).body; else entry(t.name).body = bodyIn.value;
      save();
      renderList();
      resetBtn.disabled = !current().modified;
    };
    // Tab in the template text indents instead of leaving the field.
    bodyIn.onkeydown = (e) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      bodyIn.setRangeText('    ', bodyIn.selectionStart, bodyIn.selectionEnd, 'end');
      bodyIn.dispatchEvent(new Event('input'));
    };

    function renderList() {
      list.replaceChildren();
      for (const t of merge(custom)) {
        const r = el('div', 'ft-row' + (t.name === selected ? ' selected' : '') + (t.modified ? ' modified' : ''));
        r.dataset.template = t.name;
        const label = el('span', 'ft-row-name', displayName(t));
        if (!t.builtin) label.dataset.userText = '';
        const ext = el('span', 'ft-row-ext muted', t.ext ? `.${t.ext}` : '');
        ext.dataset.userText = '';
        r.append(label, ext);
        if (!t.builtin) r.appendChild(el('span', 'ft-tag muted', tr('user')));
        r.onclick = () => { selected = t.name; render(); };
        list.appendChild(r);
      }
    }
    function render() {
      renderList();
      const t = current();
      nameIn.value = t.builtin ? displayName(t) : t.name;
      nameIn.disabled = t.builtin;
      nameIn.classList.remove('invalid');
      extIn.value = t.ext;
      extIn.disabled = !!t.package;
      extIn.classList.remove('invalid');
      bodyIn.value = t.body;
      removeBtn.disabled = t.builtin;
      resetBtn.disabled = !t.builtin || !t.modified;
    }
    render();
  }

  (ide.settingsPages ||= []).push({
    id: 'file-templates', group: 'editor', title: () => tr('File and Code Templates'),
    keywords: 'file templates code template header new file python script unit test html json 파일 및 코드 템플릿 파일 템플릿 헤더',
    defaults: { [CUSTOM]: {} },
    mount: mountPage,
  });

  ide.fileTemplates = { templates, find, render, create, substitute, variables: builtinVars, unknownVars };
})();
