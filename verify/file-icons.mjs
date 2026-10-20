// File type icons: the project tree, editor tabs and Go to File show PyCharm New UI file type icons chosen by file
// name and extension, and the drawing follows the theme.
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const FILES = {
  'app.py': 'python', 'stub.pyi': 'python', 'analysis.ipynb': 'jupyter', 'config.json': 'json', 'ci.yml': 'yaml',
  'pyproject.toml': 'toml', 'README.md': 'markdown', 'notes.txt': 'text', 'index.html': 'html', 'site.css': 'css',
  'main.js': 'javaScript', 'types.ts': 'typeScript', 'schema.sql': 'sql', 'data.csv': 'csv', 'run.sh': 'shell',
  'start.bat': 'microsoftWindows', 'Dockerfile': 'docker', '.gitignore': 'gitignore', 'logo.png': 'image',
  'clip.mp4': 'video', 'voice.mp3': 'audio', 'manual.pdf': 'pdf', 'dist.zip': 'archive', 'model.pkl': 'binaryData',
  'app.db': 'database', 'settings.ini': 'config', 'requirements-dev.txt': 'text', 'LICENSE': 'text', 'mystery.xyz': 'anyType',
};

const t = await launch({ fixture: 'core', port: 9800, name: 'file-icons' });
const { js, until, check, shot, press, type } = t;
try {
  for (const name of Object.keys(FILES)) writeFileSync(path.join(t.project, name), name.endsWith('.ipynb') ? '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}' : 'x\n');
  mkdirSync(path.join(t.project, 'assets'), { recursive: true });
  await js(`ide.refreshTree()`);
  await until(`[...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === 'mystery.xyz')`, 'tree shows the files');
  const types = await js(`Object.fromEntries([...document.querySelectorAll('#tree .node')].map(n => [n.querySelector('.name').textContent, n.querySelector('.file-icon')?.dataset.type]))`);
  const wrong = Object.entries(FILES).filter(([name, want]) => types[name] !== want).map(([name, want]) => `${name}: ${types[name]} (want ${want})`);
  check(!wrong.length, `every file in the tree gets its type's icon${wrong.length ? `: ${wrong.join(', ')}` : ''}`);
  check(types.assets === 'folder', 'folders get the folder icon');
  check(await js(`[...document.querySelectorAll('#tree .node .file-icon')].every(i => i.querySelector('svg'))`), 'tree icons are SVG drawings, not emoji');

  const shown = (sel) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); return [...i.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 0).length; })()`);
  check(await shown('#tree .node .file-icon[data-type="json"]') === 1, 'exactly one drawing of an icon is visible');
  check(await js(`(() => { const i = document.querySelector('#tree .node .file-icon[data-type="gitignore"]'); return i.querySelector('.fi-dark').innerHTML === i.querySelector('.fi-light').innerHTML; })()`), 'an icon without a dark drawing keeps its own drawing in the dark theme');
  const visibleFill = () => js(`(() => { const svgs = [...document.querySelector('#tree .node .file-icon[data-type="json"]').querySelectorAll('svg')]; return svgs.find(s => s.getBoundingClientRect().width > 0)?.querySelector('[fill]')?.getAttribute('fill'); })()`);
  const darkFill = await visibleFill();
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  const lightFill = await visibleFill();
  check(darkFill === '#B589EC' && lightFill === '#834DF0', `the theme picks the matching drawing (dark ${darkFill}, light ${lightFill})`);
  await shot('tree-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');

  await openFile(t, 'config.json');
  check(await js(`document.querySelector('.tab.active .file-icon')?.dataset.type === 'json'`), 'an editor tab shows the file type icon');
  await press('Ctrl+Shift+N');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'Go to File');
  await type('site');
  await until(`document.querySelector('.popup-item.active .label')?.textContent === 'site.css'`, 'site.css found');
  check(await js(`document.querySelector('.popup-item.active .file-icon')?.dataset.type === 'css'`), 'Go to File rows show the file type icon');
  await press('Escape');
  await shot('tree-dark.png');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.finish();
