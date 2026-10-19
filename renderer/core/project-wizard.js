// New Project (PyCharm's File > New Project): a project type, name and location, a Git repository, and an
// interpreter (a new .venv, a base interpreter, or an existing one); framework types install their packages.
(() => {
  const { el, joinPath, basename } = ide.util;

  const FLASK_APP = `from flask import Flask

app = Flask(__name__)


@app.route('/')
def hello_world():  # put application's code here
    return 'Hello World!'


if __name__ == '__main__':
    app.run()
`;
  const FASTAPI_APP = `from fastapi import FastAPI

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}


@app.get("/hello/{name}")
async def say_hello(name: str):
    return {"message": f"Hello {name}"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
`;
  const FASTAPI_HTTP = `# Test your FastAPI endpoints

GET http://127.0.0.1:8000/
Accept: application/json

###

GET http://127.0.0.1:8000/hello/User
Accept: application/json

###
`;
  // PyCharm's welcome script, with its comments in the UI language.
  const welcomeScript = () => `# ${tr('This is a sample Python script.')}

# ${tr('Press Shift+F10 to execute it or replace it with your code.')}
# ${tr('Press Double Shift to search everywhere for classes, files, tool windows, actions, and settings.')}


def print_hi(name):
    # ${tr('Use a breakpoint in the code line below to debug your script.')}
    print(f'Hi, {name}')  # ${tr('Press Ctrl+F8 to toggle the breakpoint.')}


# ${tr('Press the green button in the gutter to run the script.')}
if __name__ == '__main__':
    print_hi('PyCharm')
`;
  const GITIGNORE = '.venv/\nvenv/\n__pycache__/\n*.py[cod]\n.idea/\n.ruff_cache/\n.pytest_cache/\ndist/\nbuild/\n*.egg-info/\n';

  const TYPES = [
    { id: 'python', name: () => tr('Pure Python'), icon: 'python', main: 'main.py', packages: [],
      files: (o) => (o.welcome ? { 'main.py': welcomeScript() } : {}) },
    { id: 'flask', name: () => 'Flask', icon: 'flask', main: 'app.py', packages: ['flask'],
      files: () => ({ 'app.py': FLASK_APP, templates: null, static: null }) },
    { id: 'fastapi', name: () => 'FastAPI', icon: 'fastapi', main: 'main.py', packages: ['fastapi', 'uvicorn'],
      files: () => ({ 'main.py': FASTAPI_APP, 'test_main.http': FASTAPI_HTTP }) },
    { id: 'django', name: () => 'Django', icon: 'python', main: 'manage.py', packages: ['django'], needsPackages: true,
      files: () => ({}) },
  ];

  async function openWizard() {
    const info = await ide.api.invoke('app:info');
    const bases = await ide.api.interpreters(null, ide.settings.get('interpreters.extra', []));
    const parent = ide.settings.get('newProject.location') || joinPath(info.home, 'PycharmProjects');
    let type = TYPES[0];

    const root = el('div', 'np');
    const nav = el('div', 'np-types');
    const form = el('div', 'np-form');
    root.append(nav, form);

    const field = (label, ...controls) => {
      const r = el('label', 'field');
      const box = el('div', 'field-row');
      box.append(...controls);
      r.append(el('span', null, label), box);
      return r;
    };
    const check = (id, label, on) => {
      const r = el('label', 'np-check');
      const c = el('input');
      c.type = 'checkbox';
      c.id = id;
      c.checked = on;
      r.append(c, el('span', null, label));
      return { row: r, input: c };
    };

    const name = el('input');
    name.id = 'npName';
    name.value = await ide.api.invoke('project:suggestName', parent, 'pythonProject');
    const loc = el('input');
    loc.id = 'npLocation';
    loc.value = parent;
    const browse = el('button', 'secondary', '…');
    browse.title = tr('Browse');
    browse.onclick = async (e) => { e.preventDefault(); const d = await ide.api.openFolder(); if (d) { loc.value = d; update(); } };
    const preview = el('div', 'np-preview muted');
    preview.id = 'npPreview';
    const git = check('npGit', tr('Create Git repository'), ide.settings.get('newProject.git', true));
    const welcome = check('npWelcome', tr('Create a welcome script'), true);
    const install = check('npInstall', '', true);

    // Interpreter: a new venv (default, as in PyCharm), a base interpreter as is, or an existing interpreter.
    const interpSection = el('fieldset', 'np-section');
    interpSection.appendChild(el('legend', null, tr('Interpreter type')));
    const modes = el('div', 'np-modes');
    const mode = (value, label) => {
      const r = el('label', 'np-radio');
      const i = el('input');
      i.type = 'radio';
      i.name = 'npMode';
      i.value = value;
      i.checked = value === 'venv';
      i.onchange = update;
      r.append(i, el('span', null, label));
      modes.appendChild(r);
      return i;
    };
    mode('venv', tr('Project venv'));
    mode('base', tr('Base Python'));
    mode('custom', tr('Custom environment'));
    const base = el('select');
    base.id = 'npBase';
    for (const b of bases) base.add(new Option(`${b.label}   ${b.executable}`, b.executable));
    const custom = el('select');
    custom.id = 'npCustom';
    const allInterps = [...bases, ...ide.interps.filter((x) => !bases.some((b) => ide.util.samePath(b.executable, x.executable)))];
    for (const b of allInterps) custom.add(new Option(`${b.label}   ${b.executable}`, b.executable));
    custom.add(new Option(tr('Add Local Interpreter…'), '__browse'));
    const venvPath = el('div', 'np-preview muted');
    venvPath.id = 'npVenvPath';
    const baseRow = field(tr('Python version:'), base);
    const customRow = field(tr('Interpreter:'), custom);
    interpSection.append(modes, baseRow, venvPath, customRow);

    const log = el('pre', 'np-log hidden');
    log.id = 'npLog';
    const error = el('div', 'np-error');
    form.append(
      el('div', 'np-title'),
      field(tr('Name:'), name),
      field(tr('Location:'), loc, browse),
      preview,
      git.row, welcome.row, install.row,
      interpSection,
      error,
      log,
    );

    const selectedMode = () => modes.querySelector('input:checked').value;
    const projectDir = () => joinPath(loc.value.trim(), name.value.trim());

    function update() {
      form.querySelector('.np-title').textContent = type.name();
      preview.textContent = tr('Project will be created in: {path}', { path: projectDir() });
      welcome.row.classList.toggle('hidden', type.id !== 'python');
      install.row.classList.toggle('hidden', !type.packages.length);
      install.row.querySelector('span').textContent = tr('Install {packages}', { packages: type.packages.join(', ') });
      const m = selectedMode();
      install.input.disabled = m !== 'venv' && !type.needsPackages;
      baseRow.classList.toggle('hidden', m === 'custom');
      venvPath.classList.toggle('hidden', m !== 'venv');
      venvPath.textContent = tr('Location: {path}', { path: joinPath(projectDir(), '.venv') });
      customRow.classList.toggle('hidden', m !== 'custom');
      for (const b of nav.children) b.classList.toggle('selected', b.dataset.type === type.id);
      error.textContent = '';
    }
    for (const t of TYPES) {
      const b = el('div', 'np-type');
      b.dataset.type = t.id;
      b.append(ide.icon(t.icon, '◆'), el('span', null, t.name()));
      b.onclick = () => { type = t; update(); };
      nav.appendChild(b);
    }
    name.oninput = update;
    loc.oninput = update;
    custom.onchange = async () => {
      if (custom.value !== '__browse') return;
      const file = await ide.api.openFileDialog([{ name: tr('Python interpreter'), extensions: ['exe'] }]);
      if (!file) { custom.selectedIndex = 0; return; }
      custom.add(new Option(file, file), custom.options.length - 1);
      custom.value = file;
    };
    update();

    let busy = false;
    const dlg = ide.ui.dialog({
      title: tr('New Project'),
      body: root,
      width: 860,
      buttons: [
        { label: tr('Create'), primary: true, run: async (d) => {
          if (busy) return false;
          busy = true;
          try { await create(d); } catch (e) { error.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
          busy = false;
          return false;
        } },
        { label: tr('Cancel'), run: () => !busy },
      ],
    });
    dlg.el.classList.add('np-dialog');
    dlg.el.querySelector('.dialog-buttons .primary').id = 'npCreate';
    name.focus();
    name.select();

    // Runs one setup step, streaming its output into the log; resolves to the exit code.
    const step = (title, cmd, args, cwd) => new Promise(async (resolve) => {
      log.textContent += `\n$ ${[cmd, ...args].join(' ')}\n`;
      const id = await ide.api.invoke('project:exec', cmd, args, cwd);
      ide.proc.attach(id, {
        data: (t) => { log.textContent += t; log.scrollTop = log.scrollHeight; },
        exit: (code) => { if (code !== 0) log.textContent += `${tr('{step} failed (exit code {code})', { step: title, code })}\n`; resolve(code); },
      });
    });

    async function create(d) {
      const n = name.value.trim();
      if (!n || /[<>:"/\\|?*]/.test(n)) throw new Error(tr('Enter a valid project name.'));
      if (!loc.value.trim()) throw new Error(tr('Choose a location.'));
      const dir = projectDir();
      const m = selectedMode();
      const baseInterp = bases.find((b) => b.executable === base.value) || bases[0];
      if (m !== 'custom' && !baseInterp) throw new Error(tr('No Python interpreter was found. Install Python first.'));
      const doInstall = type.packages.length && install.input.checked && !install.input.disabled;
      if (type.needsPackages && !doInstall) throw new Error(tr('{type} projects need their packages installed.', { type: type.name() }));

      log.classList.remove('hidden');
      log.textContent = tr('Creating {path}…', { path: dir });
      const files = { ...type.files({ welcome: welcome.input.checked }) };
      if (git.input.checked) files['.gitignore'] = GITIGNORE;
      await ide.api.invoke('project:create', dir, files);
      ide.settings.set('newProject.location', loc.value.trim());
      ide.settings.set('newProject.git', git.input.checked);

      // The interpreter the project will use, and how to call it.
      let python;
      if (m === 'venv') {
        if (await step(tr('Creating the virtual environment'), baseInterp.cmd, [...baseInterp.args, '-m', 'venv', '.venv'], dir)) return;
        python = { cmd: joinPath(dir, '.venv\\Scripts\\python.exe'), args: [] };
      } else if (m === 'base') python = { cmd: baseInterp.executable, args: [] };
      else python = { cmd: custom.value, args: [] };

      if (doInstall && await step(tr('Installing packages'), python.cmd, [...python.args, '-m', 'pip', 'install', ...type.packages], dir)) return;
      if (type.id === 'django' && await step(tr('Creating the Django project'), python.cmd, [...python.args, '-m', 'django', 'startproject', n.replace(/\W/g, '_'), '.'], dir)) return;
      if (git.input.checked && await step(tr('Creating the Git repository'), 'git', ['init'], dir)) return;

      d.close();
      if (m !== 'venv') {
        const extra = ide.settings.get('interpreters.extra', []);
        if (!extra.some((p) => ide.util.samePath(p, python.cmd))) ide.settings.set('interpreters.extra', [...extra, python.cmd]);
      }
      ide.settings.set(`interpreter.${dir}`, python.cmd);
      await ide.openProject(dir);
      ide.setInterpreter(python.cmd);
      const main = joinPath(dir, type.main);
      if (await ide.api.exists(main)) await ide.openFile(main);
    }
  }

  ide.registerAction({ id: 'NewProject', title: tr('New Project…'), run: openWizard });
  ide.newProject = openWizard;
})();
