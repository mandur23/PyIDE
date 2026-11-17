// A project without Python is not shown Python: no interpreter in the status bar, no Pyright, and no interpreter chip
// or Virtual Environments card on the Workspace page, until a Python file is opened. A .class file opens as the
// declaration javap prints, with a button for its source file (a JDK on this computer is used when there is one;
// without it the page says so and the button still works). Port 9873.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'pyide-project-kind-'));
const project = path.join(base, 'shop');
const src = path.join(project, 'src', 'main', 'java', 'com', 'shop');
mkdirSync(src, { recursive: true });
mkdirSync(path.join(project, 'build', 'classes', 'com', 'shop'), { recursive: true });
// A build folder's leftovers are not the project's own sources.
mkdirSync(path.join(project, 'node_modules', 'tool'), { recursive: true });
writeFileSync(path.join(project, 'node_modules', 'tool', 'setup.py'), 'print(1)\n');
writeFileSync(path.join(project, 'build.gradle'), "plugins { id 'java' }\n");
writeFileSync(path.join(project, 'README.md'), '# Shop\n');
writeFileSync(path.join(src, 'Price.java'), 'package com.shop;\n\npublic record Price(String code, long cents) {\n    public static final int SCALE = 100;\n}\n');
const classFile = path.join(project, 'build', 'classes', 'com', 'shop', 'Price.class');

const t = await launch({ name: 'project-kind', port: 9873, projectDir: project });
const { js, until, check, sleep } = t;
const S = JSON.stringify;
const shown = (sel) => js(`(() => { const n = document.querySelector(${S(sel)}); return !!n && getComputedStyle(n).display !== 'none' && !n.classList.contains('hidden'); })()`);
try {
  await until('ide.pythonProject === false', 'the project is known to have no Python', 20000);
  check(true, 'a Gradle project with no Python file (one in node_modules does not count) is not a Python project');
  await until(`!!document.querySelector('#wsHome .ws-hero')`, 'the Workspace page');
  check(!(await shown('#statusInterp')), 'the status bar shows no Python interpreter');
  check(!(await shown('#lspStatus')) && await js(`document.querySelector('#lspStatus').dataset.state !== 'ready' && document.querySelector('#lspStatus').dataset.state !== 'starting'`), 'Pyright is not started and has no status item');
  check(await js(`!document.querySelector('#wsHome .ws-interp') && !document.querySelector('#wsHome .ws-card-venvs') && !!document.querySelector('#wsHome .ws-card-readme')`),
    'the Workspace page has no interpreter chip and no Virtual Environments card');

  // ---------- a compiled class ----------
  const jdk = await js(`ide.toolchains.list('jdk').then((l) => l[0] ? { home: l[0].home } : null)`);
  let compiled = false;
  if (jdk) {
    try {
      execFileSync(path.join(jdk.home, 'bin', 'javac.exe'), ['-d', path.join(project, 'build', 'classes'), path.join(src, 'Price.java')], { windowsHide: true, timeout: 120000 });
      compiled = existsSync(classFile);
    } catch (err) { console.log(`javac failed: ${String(err.message).split('\n')[0]}`); }
  }
  if (!compiled) writeFileSync(classFile, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65, 0, 1]));
  await js(`ide.openFile(${S(classFile)}).then(() => true)`);
  await until(`!!document.querySelector('.tc-class .monaco-editor .view-line') || !!document.querySelector('.tc-class-message')`, 'the class page', 40000);
  if (compiled) {
    const text = await js(`ide.monaco.editor.getEditors().find((e) => e.getDomNode()?.closest('.tc-class'))?.getValue() || ''`);
    check(/Compiled from "Price\.java"/.test(text) && /public final class com\.shop\.Price extends java\.lang\.Record/.test(text) && /public static final int SCALE = 100;/.test(text),
      `a .class file opens as its declaration, with members and constants (${S(text.slice(0, 120))})`);
    check(await js(`ide.monaco.editor.getEditors().find((e) => e.getDomNode()?.closest('.tc-class')).getOption(ide.monaco.editor.EditorOption.readOnly)`), 'the declaration is read-only');
  } else {
    check(/JDK|javap/.test(await js(`document.querySelector('.tc-class-message')?.textContent || ''`)), 'without a usable JDK the class page says what is missing instead of showing bytes');
  }
  check(!(await js(`[...document.querySelectorAll('.custom-tab:not(.hidden) *')].some((n) => /binary|바이너리/i.test(n.textContent) && n.children.length === 0)`)), 'a .class file is not refused as a binary file');
  await until(`!document.querySelector('.tc-class-source').classList.contains('hidden')`, 'the source button', 10000);
  check(await js(`document.querySelector('.tc-class-source').textContent`) === 'Open Price.java', 'the page offers the source file the class was compiled from');
  await t.click('.tc-class-source');
  await until(`ide.activeTab()?.path?.toLowerCase() === ${S(path.join(src, 'Price.java').toLowerCase())}`, 'Price.java opened');
  check(true, 'the button opens the source file');
  check(await js('ide.pythonProject') === false, 'Java files do not make it a Python project');

  // ---------- a Python file makes it a Python project ----------
  writeFileSync(path.join(project, 'tool.py'), 'print("hi")\n');
  await js(`ide.openFile(${S(path.join(project, 'tool.py'))}).then(() => true)`);
  await until('ide.pythonProject === true', 'a Python project once a Python file is open');
  await until(`getComputedStyle(document.querySelector('#statusInterp')).display !== 'none'`, 'the interpreter in the status bar');
  check(await shown('#lspStatus'), 'opening a Python file brings the interpreter and Pyright back');
  await js(`(ide.runAction('WorkspaceHome'), true)`);
  await until(`!!document.querySelector('#wsHome .ws-interp') && !!document.querySelector('#wsHome .ws-card-venvs')`, 'the Workspace page shows the Python parts');
  check(true, 'the Workspace page shows the interpreter chip and the Virtual Environments card again');
  check(t.consoleErrors.length === 0, `no renderer exceptions (${t.consoleErrors.join(' | ')})`);
  await sleep(100);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
