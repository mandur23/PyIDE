// Completing a function or method adds its parentheses, as PyCharm does (renderer/features/lsp, CALL_PARENS). Port 9375.
// A temp project with bank.py (Account.deposit(amount), Account.close(), make_account, deco). Real typing and Enter in
// the suggest widget: the caret lands inside `()` with parameter info for a callable with parameters, after `()` for
// one without, and a typed `)` steps over the added one; a `(` typed right after the pair steps into it. No parentheses after `@`, in imports (one line or in
// parentheses), for a class, or where `(` already follows.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const project = path.join(tempDir('completion-parens'), 'proj');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'bank.py'), [
  'class Account:',
  '    def __init__(self, owner):',
  '        self.owner = owner',
  '        self.balance = 0',
  '',
  '    def deposit(self, amount):',
  '        self.balance += amount',
  '',
  '    def close(self):',
  '        self.balance = 0',
  '',
  '',
  'def make_account(owner):',
  '    return Account(owner)',
  '',
  '',
  'def deco(func):',
  '    return func',
  '',
].join('\n'));
writeFileSync(path.join(project, 'main.py'), 'from bank import Account, deco\n\nacct = Account("kim")\n');

const t = await launch({ fixture: 'core', port: 9375, name: 'completion-parens', projectDir: project });
const { js, until, press, type, check, sleep } = t;

const setText = (text) => js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: ${S(text)} }], () => null); return true; })()`);
const caretAtEnd = (line) => js(`(() => { const e = ide.editor; e.focus(); e.setPosition({ lineNumber: ${line}, column: e.getModel().getLineMaxColumn(${line}) }); return true; })()`);
const caretAt = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), true)`);
const lineText = (line) => js(`ide.editor.getModel().getLineContent(${line})`);
const column = () => js(`ide.editor.getPosition().column`);
const row = (label) => `[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].find((r) => r.querySelector('.label-name')?.textContent === ${S(label)})`;
const hintsShown = `[...document.querySelectorAll('.parameter-hints-widget')].some((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && n.textContent.includes('amount'))`;

// Types the prefix, opens completion, focuses `label` with the arrow keys and accepts it with Enter. Then waits until
// the parentheses (if any) are settled: the version stops changing for a moment.
async function complete(prefix, label) {
  if (prefix) await type(prefix);
  await js(`(ide.editor.trigger('test', 'editor.action.triggerSuggest', {}), true)`);
  await until(`!!${row(label)}`, `${label} offered`, 30000);
  for (let i = 0; i < 30 && !(await js(`!!${row(label)}?.classList.contains('focused')`)); i++) await press('ArrowDown');
  await press('Enter');
  await until(`!document.querySelector('.suggest-widget.visible')`, 'suggest widget closed', 5000);
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const v = await js(`ide.editor.getModel().getVersionId()`);
    if (v === last) break;
    last = v;
    await sleep(250);
  }
}

try {
  await openFile(t, 'main.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);

  // A method with a parameter: caret inside, parameter info shown; the typed ) steps over the added one.
  await setText('from bank import Account, deco\n\nacct = Account("kim")\n\n');
  await caretAtEnd(4);
  await complete('acct.dep', 'deposit');
  check(await lineText(4) === 'acct.deposit()' && await column() === 'acct.deposit('.length + 1, `completing a method with a parameter inserts () with the caret inside (${S(await lineText(4))}, column ${await column()})`);
  await until(hintsShown, 'parameter info after the completion', 10000).catch(() => {});
  check(await js(hintsShown), 'the parameter info shows the method\'s parameter (amount)');
  await type('5');
  await type(')');
  check(await lineText(4) === 'acct.deposit(5)' && await column() === 'acct.deposit(5)'.length + 1, `typing ) steps over the added parenthesis (${S(await lineText(4))})`);

  // A method without parameters: caret after ().
  await press('Escape');
  await setText('from bank import Account, deco\n\nacct = Account("kim")\n\n');
  await caretAtEnd(4);
  await complete('acct.clo', 'close');
  await until(`ide.editor.getModel().getLineContent(4) === 'acct.close()' && ide.editor.getPosition().column === 13`, 'caret after () of close', 10000).catch(() => {});
  check(await lineText(4) === 'acct.close()' && await column() === 'acct.close()'.length + 1, `completing a method without parameters puts the caret after () (${S(await lineText(4))}, column ${await column()})`);

  // Typing the call out of habit after the added pair: ( steps into it, ) over it; one key at a time or at once.
  for (const [prefix, label, keys, want] of [['acct.dep', 'deposit', ['(', '5', ')'], 'acct.deposit(5)'], ['acct.dep', 'deposit', ['(5)'], 'acct.deposit(5)'], ['acct.clo', 'close', ['(', ')'], 'acct.close()'], ['acct.clo', 'close', ['()'], 'acct.close()']]) {
    await press('Escape');
    await setText('from bank import Account, deco\n\nacct = Account("kim")\n\n');
    await caretAtEnd(4);
    await complete(prefix, label);
    for (const k of keys) await type(k);
    check(await lineText(4) === want && await column() === want.length + 1, `typing ${keys.join(' then ')} after completing ${label} gives ${want} (${S(await lineText(4))}, column ${await column()})`);
  }

  // A builtin function.
  await setText('from bank import Account, deco\n\nacct = Account("kim")\n\n');
  await caretAtEnd(4);
  await complete('pri', 'print');
  check(await lineText(4) === 'print()' && await column() === 'print('.length + 1, `completing print inserts print() with the caret inside (${S(await lineText(4))}, column ${await column()})`);
  await press('Escape');

  // `(` already follows: nothing added.
  await setText('from bank import Account, deco\n\nacct = Account("kim")\nacct.dep(5)\n');
  await caretAt(4, 'acct.dep'.length + 1);
  await complete('', 'deposit');
  check(await lineText(4) === 'acct.deposit(5)', `no second ( where one follows (${S(await lineText(4))})`);
  await press('Escape');

  // A decorator: no call.
  await setText('from bank import Account, deco\n\n\n\ndef f():\n    pass\n');
  await caretAt(4, 1);
  await complete('@dec', 'deco');
  check(await lineText(4) === '@deco', `no parentheses after @ (${S(await lineText(4))})`);

  // Imports, on one line and in parentheses.
  await setText('from bank import Account, deco\nfrom bank import \n');
  await caretAtEnd(2);
  await complete('make_acc', 'make_account');
  check(await lineText(2) === 'from bank import make_account', `no parentheses in an import (${S(await lineText(2))})`);
  await setText('from bank import Account, deco\nfrom bank import (\n    \n)\n');
  await caretAtEnd(3);
  await complete('make_acc', 'make_account');
  check(await lineText(3) === '    make_account', `no parentheses in a parenthesized import (${S(await lineText(3))})`);

  // A class: no parentheses (it is as often an annotation or a base class as a call).
  await setText('from bank import Account, deco\n\nx = \n');
  await caretAtEnd(3);
  await complete('Acc', 'Account');
  check(await lineText(3) === 'x = Account', `no parentheses for a class (${S(await lineText(3))})`);
} catch (err) {
  check(false, err.stack || err.message);
}
t.finish();
