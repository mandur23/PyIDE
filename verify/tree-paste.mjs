// Copy and paste in the project tree through the system clipboard: files and folders copied in Explorer are pasted
// with Ctrl+V into the selected folder, folders with everything in them; Ctrl+C in the tree puts the selection on the
// clipboard as files (Explorer pastes them), and pasted beside its source a copy gets Explorer's "- Copy" name.
// The clipboard is written and read for real (PowerShell, as Explorer's file list) and put back afterwards. Port 9788.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'pyide-tree-paste-'));
const project = path.join(base, 'project');
const outside = path.join(base, 'outside');
mkdirSync(path.join(project, 'docs'), { recursive: true });
mkdirSync(path.join(outside, 'folder', 'inner'), { recursive: true });
mkdirSync(path.join(outside, '과제'), { recursive: true });
writeFileSync(path.join(project, 'notes.txt'), 'notes\n');
writeFileSync(path.join(project, 'docs', 'readme.txt'), 'readme\n');
writeFileSync(path.join(outside, 'a.txt'), 'a\n');
writeFileSync(path.join(outside, 'folder', 'c.txt'), 'c\n');
writeFileSync(path.join(outside, 'folder', 'inner', 'd.txt'), 'd\n');
writeFileSync(path.join(outside, '과제', '숙제.py'), 'print(1)\n');

// The clipboard's file list, as Explorer writes and reads it. Paths go through a UTF-8 file: no code page on the way.
const listFile = path.join(base, 'clip.txt');
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-STA', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
const setFiles = (paths) => {
  writeFileSync(listFile, paths.join('\n'), 'utf8');
  ps(`Set-Clipboard -LiteralPath @(Get-Content -LiteralPath '${listFile}' -Encoding UTF8)`);
};
const getFiles = () => {
  ps(`Set-Content -LiteralPath '${listFile}' -Encoding UTF8 -Value @(Get-Clipboard -Format FileDropList | ForEach-Object { "$_" })`);
  return readFileSync(listFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
};
const savedFiles = getFiles();
const savedText = savedFiles.length ? '' : ps('Get-Clipboard -Raw').replace(/\r?\n$/, '');

const t = await launch({ name: 'tree-paste', port: 9788, projectDir: project });
const { js, until, check, press, sleep } = t;
const S = JSON.stringify;
const row = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n._entry && n._entry.path.endsWith(${S('\\' + name)}))`;
const select = async (name) => {
  await until(`!!${row(name)}`, `row ${name}`);
  await js(`(${row(name)}.click(), document.getElementById('tree').focus(), true)`);
};
const appears = async (...parts) => {
  const p = path.join(project, ...parts);
  for (let i = 0; i < 60 && !existsSync(p); i++) await sleep(250);
  return existsSync(p);
};

try {
  await until(`!!${row('notes.txt')} && !!${row('docs')}`, 'tree rows');

  setFiles([path.join(outside, 'a.txt'), path.join(outside, 'folder'), path.join(outside, '과제')]);
  await select('docs');
  await press('Ctrl+V');
  check(await appears('docs', 'a.txt'), 'a file copied in Explorer is pasted into the selected folder');
  check(await appears('docs', 'folder', 'inner', 'd.txt') && existsSync(path.join(project, 'docs', 'folder', 'c.txt')),
    'a folder copied in Explorer is pasted as a folder, with the folders and files in it');
  check(await appears('docs', '과제', '숙제.py'), 'a folder with a Korean name is pasted too');
  check(existsSync(path.join(outside, 'folder', 'c.txt')), 'the sources stay where they were (a copy)');
  await until(`!!${row('docs\\folder')}`, 'the pasted folder is a row of the tree', 10000);
  check(true, 'the tree shows the pasted folder as a folder row');

  await select('notes.txt');
  await press('Ctrl+C');
  let onClipboard = [];
  for (let i = 0; i < 40; i++) {
    onClipboard = getFiles();
    if (onClipboard.length === 1 && onClipboard[0].toLowerCase() === path.join(project, 'notes.txt').toLowerCase()) break;
    await sleep(250);
  }
  check(onClipboard.length === 1 && onClipboard[0].toLowerCase() === path.join(project, 'notes.txt').toLowerCase(),
    `Ctrl+C in the tree puts the file on the system clipboard as a file, for Explorer (${S(onClipboard)})`);
  await press('Ctrl+V');
  check(await appears('notes - Copy.txt') && existsSync(path.join(project, 'notes.txt')), 'pasted beside its source, a file becomes "notes - Copy.txt"');
  await select('notes.txt');
  await press('Ctrl+V');
  check(await appears('notes - Copy (2).txt'), 'a second paste becomes "notes - Copy (2).txt"');

  // A folder copied in the tree (with a Korean name inside it), through the menu's Paste on the project's own row.
  await select('docs');
  await press('Ctrl+C');
  for (let i = 0; i < 40 && getFiles()[0]?.toLowerCase() !== path.join(project, 'docs').toLowerCase(); i++) await sleep(250);
  await js(`(() => { const n = document.querySelector('#tree .node'); const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 30, clientY: r.y + 8, button: 2 })); return true; })()`);
  await until(`!![...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Paste')`, 'the menu with Paste');
  await js(`([...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Paste').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  check(await appears('docs - Copy', '과제', '숙제.py') && existsSync(path.join(project, 'docs - Copy', 'readme.txt')),
    "a folder copied in the tree and pasted with the menu's Paste beside itself becomes \"docs - Copy\", with its contents");

  // Cut and paste still moves.
  await js(`(ide.ui.confirm = async () => true, ide.treeMoveHandlers.length = 0, true)`);
  await select('notes - Copy.txt');
  await press('Ctrl+X');
  await select('docs');
  await press('Ctrl+V');
  check(await appears('docs', 'notes - Copy.txt') && !existsSync(path.join(project, 'notes - Copy.txt')), 'Ctrl+X then Ctrl+V still moves the row');
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
try {
  if (savedFiles.some((p) => existsSync(p))) setFiles(savedFiles.filter((p) => existsSync(p)));
  else if (savedText) execFileSync('powershell', ['-NoProfile', '-STA', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], { input: savedText, windowsHide: true });
  else ps('Set-Clipboard -Value $null');
} catch {}
t.finish();
