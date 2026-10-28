// AI actions Write Documentation and Generate Unit Tests (renderer/features/ai-generate, main/features/ai-generate.js)
// against verify/fake-claude-generate.mjs, a stand-in Claude Code CLI (PYIDE_CLAUDE_PATH) with deterministic answers:
// no model or network is used. The generated tests run with the default interpreter's pytest. Ports 9010-9012.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { clickMenuPath, launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const require = createRequire(import.meta.url);
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const G = require('../main/ai/generate-text.js');
const AG = require('../main/features/ai-generate.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const nl = (s) => s.replace(/\r\n/g, '\n');

// ---------- the stand-in CLI ----------
const fakeDir = mkdtempSync(path.join(tmpdir(), 'pyide-fake-claude-gen-'));
const fakeCmd = path.join(fakeDir, 'claude.cmd');
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${path.join(APP, 'verify', 'fake-claude-generate.mjs')}" %*\r\n`);
writeFileSync(path.join(fakeDir, 'log.jsonl'), '');
const scenario = (s) => writeFileSync(path.join(fakeDir, 'scenario.json'), J(s));
const calls = () => readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
scenario({});
process.env.PYIDE_CLAUDE_PATH = fakeCmd;
process.env.FAKE_CLAUDE_DIR = fakeDir;

const unit = [];
const ucheck = (ok, label) => { unit.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// ===================================================================== pure Node
{
  const shapes = nl(readFileSync(path.join(APP, 'verify', 'fixtures', 'ai-generate', 'shapes.py'), 'utf8'));
  const lineOf = (text, prefix) => text.split('\n').findIndex((l) => l.startsWith(prefix)) + 1;
  const m = G.findTarget(shapes, lineOf(shapes, '        return area(self.width'));
  ucheck(m && G.qualname(m) === 'Rect.area' && G.kindOf(m) === 'method', 'the innermost def at the caret is the method Rect.area');
  const ctx = G.buildContext(shapes, m, { purpose: 'tests' });
  ucheck(ctx.imports === 'import math' && ctx.classHeader === 'class Rect:' && ctx.code.startsWith('    def area(self) -> float:')
    && ctx.helpers.map((h) => h.name).join() === 'Rect.__init__,area' && !ctx.code.includes('circle_area') && !ctx.helpers.some((h) => h.code.includes('def checked')),
  `context: the imports, the class header, the method, __init__ and the called helper only (${ctx.helpers.map((h) => h.name)})`);
  const sig = G.signature(shapes, G.findTarget(shapes, lineOf(shapes, 'def area')));
  ucheck(J(sig.params.map((p) => [p.name, p.annotation])) === J([['width', 'float'], ['height', 'float']]) && sig.returns === 'float' && sig.raises.join() === 'ValueError',
    'signature: parameters with type hints, return annotation and raised exceptions');
  const big = `import os\n\ndef huge(x):\n${Array.from({ length: 3000 }, (_, i) => `    x += ${i}  # padding padding padding`).join('\n')}\n    return x\n`;
  const hctx = G.buildContext(big, G.findTarget(big, 3));
  ucheck(hctx.truncated && hctx.code.length <= G.LIMITS.code + 60 && /more lines not shown/.test(hctx.code), `a huge function is cut at ${G.LIMITS.code} characters (${hctx.code.length})`);

  const geometry = readFileSync(path.join(APP, 'verify', 'fixtures', 'ai-generate', 'geometry.py'), 'utf8');
  const rest = 'def f(a):\n    """Do.\n\n    :param a: A.\n    :return: B.\n    """\n';
  const numpy = 'def f(a):\n    """Do.\n\n    Parameters\n    ----------\n    a : int\n        A.\n    """\n';
  ucheck(G.detectDocstringFormat([geometry]).format === 'google' && G.detectDocstringFormat([rest]).format === 'restructuredtext'
    && G.detectDocstringFormat([numpy]).format === 'numpy' && G.detectDocstringFormat([shapes]).format === null
    && G.detectDocstringFormat([geometry, rest, rest, rest]).format === 'restructuredtext', 'docstring formats are detected: Google, reST, NumPy, none, majority');
  ucheck(G.detectQuote("def f():\n    '''A.'''\n") === "'''" && G.detectQuote(shapes) === '"""', 'the file\'s docstring quotes are detected');
  ucheck(J(G.formatDocstring('One line.', '    ', '"""')) === J(['    """One line."""'])
    && J(G.formatDocstring('Sum.\n\nArgs:\n    a: A.', '\t', "'''")) === J(["\t'''Sum.", '', '\tArgs:', '\t    a: A.', "\t'''"])
    && G.formatDocstring('Says """hi""".', '', '"""')[0] === "'''Says \"\"\"hi\"\"\".'''", 'formatting: one line, indentation, quote style, embedded quotes');
  ucheck(G.cleanDocstring('```python\n"""Hello.\n\n    Args:\n        x: y\n"""\n```') === 'Hello.\n\nArgs:\n    x: y', 'the answer loses fences, quotes and its indentation');
  const placed = G.placeDocstring(shapes, { line: lineOf(shapes, 'def circle_area'), name: 'circle_area', content: 'New.', quote: "'''" });
  ucheck(placed.replacing && placed.start === lineOf(shapes, '    """Old docstring.') && placed.end === placed.start + 4 && placed.lines[0] === '    """New."""',
    'an existing docstring is replaced in place and keeps its quotes');
  ucheck(G.placeDocstring('def f(): return 1\n', { line: 1, name: 'f', content: 'X.' }).error === 'one-line', 'a one-line def is refused');

  const existing = 'import unittest\r\n\r\nfrom app import f\r\n\r\n\r\nclass TestF(unittest.TestCase):\r\n    def test_f(self):\r\n        pass\r\n\r\n\r\nif __name__ == "__main__":\r\n    unittest.main()\r\n';
  const gen = 'import unittest\nimport math\n\nfrom app import f\n\n\nclass TestF(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 1)\n\n\nif __name__ == "__main__":\n    unittest.main()\n';
  const merged = G.mergeTests(existing, gen);
  ucheck(merged.text === 'import unittest\r\n\r\nfrom app import f\r\nimport math\r\n\r\n\r\nclass TestF(unittest.TestCase):\r\n    def test_f(self):\r\n        pass\r\n\r\n\r\nclass TestF2(unittest.TestCase):\r\n    def test_f(self):\r\n        self.assertEqual(f(), 1)\r\n\r\n\r\nif __name__ == "__main__":\r\n    unittest.main()\r\n'
    && J(merged.renamed) === J([{ from: 'TestF', to: 'TestF2' }]), 'merge: new imports after the old ones, a clashing class renamed, before the __main__ block, CRLF kept');
  ucheck(J(G.moduleOf('src/shop/cart.py', { srcLayout: true })) === J({ module: 'shop.cart', leaf: 'cart', layout: 'src' })
    && G.moduleOf('pkg/__init__.py', {}).module === 'pkg' && G.moduleOf('my-scripts/x.py', {}).error === 'not-importable', 'module paths: src layout, packages, not importable');

  // Framework and layout from the project on disk.
  const base = mkdtempSync(path.join(tmpdir(), 'pyide-aig-unit-'));
  const uproj = path.join(base, 'uproj');
  mkdirSync(path.join(uproj, 'tests'), { recursive: true });
  writeFileSync(path.join(uproj, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(path.join(uproj, 'tests', '__init__.py'), '');
  writeFileSync(path.join(uproj, 'tests', 'test_old.py'), 'import unittest\n\n\nclass TestOld(unittest.TestCase):\n    def test_x(self):\n        pass\n');
  const up = await AG.testPlan(uproj, path.join(uproj, 'calc.py'), 'def add(a, b):\n    return a + b\n', 1);
  ucheck(up.ok && up.framework === 'unittest' && up.testRel === 'tests/test_calc.py' && up.importLine === 'from calc import add' && !up.createInit,
    `a project whose tests use unittest.TestCase gets unittest tests (${up.framework}, ${up.testRel})`);
  const sproj = path.join(base, 'sproj');
  mkdirSync(path.join(sproj, 'src', 'shop'), { recursive: true });
  writeFileSync(path.join(sproj, 'src', 'shop', 'cart.py'), 'def total(p):\n    return sum(p)\n');
  const sp = await AG.testPlan(sproj, path.join(sproj, 'src', 'shop', 'cart.py'), 'def total(p):\n    return sum(p)\n', 1);
  ucheck(sp.ok && sp.framework === 'pytest' && sp.importLine === 'from shop.cart import total' && sp.layout === 'src' && sp.notes.includes('src-path'),
    'src layout without pytest\'s pythonpath: imports from the package and notes that src is not on the path');
  writeFileSync(path.join(sproj, 'pyproject.toml'), '[tool.pytest.ini_options]\npythonpath = ["src"]\n');
  const sp2 = await AG.testPlan(sproj, path.join(sproj, 'src', 'shop', 'cart.py'), 'def total(p):\n    return sum(p)\n', 1);
  ucheck(sp2.ok && !sp2.notes.includes('src-path'), 'with pythonpath = ["src"] there is no note');

  // Line separators: an existing file keeps its main one (CR too); a new file gets the new-file separator.
  const genT = 'def test_g():\n    assert True\n';
  ucheck(G.mergeTests('def test_a():\r    pass\r', genT).text === 'def test_a():\r    pass\r\r\rdef test_g():\r    assert True\r'
    && G.mergeTests(null, genT, { newFileEol: '\r\n' }).text === 'def test_g():\r\n    assert True\r\n'
    && G.mergeTests('', genT, { newFileEol: '\n' }).text === genT
    && G.mergeTests('x = 1\n', genT, { newFileEol: '\r\n' }).text.includes('x = 1\n\n\ndef test_g'),
  'merge: a CR file stays CR, a new file uses the new-file separator, an LF file stays LF');

  // The IPC handlers with the stand-in CLI: a CP949 test file that is not open keeps its bytes; > 4 MB is refused.
  const handlers = {};
  AG.register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
  const iconv = require('iconv-lite');
  const cproj = path.join(base, 'cproj');
  mkdirSync(path.join(cproj, 'tests'), { recursive: true });
  const calcSrc = 'def add(a, b):\n    return a + b\n';
  writeFileSync(path.join(cproj, 'calc.py'), calcSrc);
  const cpTest = path.join(cproj, 'tests', 'test_calc.py');
  const cpOld = '# 한글 주석입니다\r\nfrom calc import add\r\n\r\n\r\ndef test_add():\r\n    assert add(1, 2) == 3  # 덧셈\r\n';
  const cpBytes = iconv.encode(cpOld, 'cp949');
  writeFileSync(cpTest, cpBytes);
  const trustAll = process.env.PYIDE_TRUST_ALL;
  process.env.PYIDE_TRUST_ALL = '1';
  scenario({ tests: { reply: 'from calc import add\n\n\ndef test_add():\n    assert add(-1, 1) == 0  # 음수\n' } });
  const req = { reqId: 'u1', root: cproj, path: path.join(cproj, 'calc.py'), text: calcSrc, line: 1, model: 'haiku', newFileSeparator: '\n' };
  const cres = await handlers['ai-generate:tests'](null, req);
  ucheck(cres.ok && cres.encoding === 'cp949' && cres.before === cpOld && cres.after.includes('# 음수') && cres.after.includes('\r\ndef test_add_2():\r\n'),
    `a CP949 test file is read in CP949 and the merge keeps CRLF (${cres.code || cres.encoding})`);
  const cw = await handlers['ai-generate:writeTests'](null, { root: cproj, testPath: cpTest, before: cres.before, after: cres.after });
  const cpNow = readFileSync(cpTest);
  ucheck(cw.ok && cpNow.subarray(0, cpBytes.length).equals(cpBytes) && iconv.decode(cpNow, 'cp949') === cres.after,
    'Append writes CP949: the old bytes are unchanged and the new Korean comment is CP949');
  // Characters CP949 cannot hold are refused before anything is written.
  scenario({ tests: { reply: 'def test_emoji():\n    assert "😀"\n' } });
  const emo = await handlers['ai-generate:tests'](null, { ...req, reqId: 'u2' });
  ucheck(!emo.ok && emo.code === 'unencodable' && emo.encoding === 'cp949' && emo.testRel === 'tests/test_calc.py', `an emoji in a CP949 file is refused (${emo.code})`);
  ucheck((await handlers['ai-generate:writeTests'](null, { root: cproj, testPath: cpTest, before: iconv.decode(cpNow, 'cp949'), after: `${iconv.decode(cpNow, 'cp949')}# 😀\r\n` })).code === 'unencodable'
    && readFileSync(cpTest).equals(cpNow), 'writeTests refuses text CP949 cannot hold and leaves the file alone');
  // Bytes that do not decode as CP949 (they would come back as U+FFFD) are refused, not rewritten.
  const broken = Buffer.concat([Buffer.from('x = 1  # '), Buffer.from([0xc7, 0xd1, 0xff, 0x80]), Buffer.from('\n')]);
  writeFileSync(cpTest, broken);
  scenario({});
  const br = await handlers['ai-generate:tests'](null, { ...req, reqId: 'u3' });
  ucheck(!br.ok && br.code === 'encoding' && readFileSync(cpTest).equals(broken), `a file whose bytes would not survive a round trip is refused (${br.code})`);
  // Over 4 MB: refused, never truncated.
  const bigText = `# ${'x'.repeat(AG.MAX_TEST_FILE)}\n`;
  writeFileSync(cpTest, bigText);
  const bg = await handlers['ai-generate:tests'](null, { ...req, reqId: 'u4' });
  const bgw = await handlers['ai-generate:writeTests'](null, { root: cproj, testPath: cpTest, before: bigText.slice(0, AG.MAX_TEST_FILE), after: 'x = 1\n' });
  ucheck(!bg.ok && bg.code === 'too-large' && bgw.code === 'too-large' && readFileSync(cpTest, 'utf8') === bigText, 'a test file over 4 MB is refused, not truncated');
  // A new test file uses the separator it is given.
  rmSync(cpTest);
  const nw = await handlers['ai-generate:tests'](null, { ...req, reqId: 'u5', newFileSeparator: '\r\n' });
  const nww = nw.ok && await handlers['ai-generate:writeTests'](null, { root: cproj, testPath: cpTest, before: nw.before, after: nw.after });
  ucheck(nww?.ok && /\r\n/.test(readFileSync(cpTest, 'utf8')) && !/[^\r]\n/.test(readFileSync(cpTest, 'utf8')), 'a new test file is written with the new-file separator (CRLF)');
  if (trustAll === undefined) delete process.env.PYIDE_TRUST_ALL; else process.env.PYIDE_TRUST_ALL = trustAll;
  scenario({});
}

// ===================================================================== app helpers
async function helpers(t) {
  const { js, until, press, cdp } = t;
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  const h = {
    settles: (expr, label, ms = 5000) => until(expr, label, ms).then(() => true, () => false),
    text: () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`),
    lineOf: (prefix) => js(`ide.editor.getModel().getLinesContent().findIndex((l) => l.startsWith(${J(prefix)})) + 1`),
    async caret(prefix, column) {
      const line = await h.lineOf(prefix);
      if (!line) throw new Error(`no line starting with ${prefix}`);
      await js(`(ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), ide.editor.revealLineInCenter(${line}), ide.editor.focus(), true)`);
      return line;
    },
    // Clicks the first visible element matching `selector` (a root may be a shadow root) whose text includes `text`.
    async clickText(selector, text = '') {
      await frame();
      const box = await js(`(() => {
        const roots = [document, ...[...document.querySelectorAll('*')].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
        const n = roots.flatMap((r) => [...r.querySelectorAll(${J(selector)})]).find((x) => x.getClientRects().length && x.textContent.includes(${J(text)}));
        if (!n) return null;
        n.scrollIntoView?.({ block: 'nearest' });
        const r = n.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) throw new Error(`no element ${selector} with "${text}"`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(100);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(100);
    },
    exists: (selector, text = '') => js(`(() => { const roots = [document, ...[...document.querySelectorAll('*')].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
      return roots.some((r) => [...r.querySelectorAll(${J(selector)})].some((x) => x.getClientRects().length && x.textContent.includes(${J(text)}))); })()`),
    async altEnter(label) {
      for (let i = 0; i < 3; i++) {
        await press('Alt+Enter');
        if (await h.settles(`[...document.querySelectorAll('.action-widget [role="option"]')].some((n) => n.textContent.includes(${J(label)}))`, 'action listed', 6000)) return true;
        await press('Escape');
        await sleep(1000);
      }
      return false;
    },
    // Right-click on the caret's line opens the editor's context menu.
    async contextMenu(line) {
      await frame();
      const pt = await js(`(() => { const ed = ide.editor; const p = ed.getScrolledVisiblePosition({ lineNumber: ${line}, column: 5 }); const r = ed.getDomNode().getBoundingClientRect();
        return { x: r.x + p.left + 2, y: r.y + p.top + p.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
      await sleep(200);
    },
    state: () => js('ide.aiGenerate.state()'),
    review: () => js('ide.aiEdit.session()'),
    lastCall: () => calls().at(-1),
    balloon: (text) => js(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes(${J(text)}))`),
  };
  return h;
}

const waitTests = (t, label, ms = 60000) => t.until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running' && /Tests|테스트/.test(s.textContent); })()`, label, ms);
const testStatus = (t) => t.js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);
const logText = (t) => { try { return readFileSync(path.join(t.userData, 'logs', 'pyide.log'), 'utf8'); } catch { return ''; } };

let failedApp = false;

// ===================================================================== A: flat project, English, DEBUG log
{
  const t = await launch({ fixture: 'ai-generate', port: 9010, name: 'ai-generate', env: { PYIDE_LOG_LEVEL: 'DEBUG' } });
  const { js, until, press, check, shot, project } = t;
  const h = await helpers(t);
  try {
    await openFile(t, 'shapes.py');
    await until(`ide.editor.getModel()?.getLineCount() > 30`, 'shapes.py loaded');
    const SHAPES = await h.text();
    // Pyright's first markers cancel a quick fix request that is under way; wait for them, as verify/ai-chat.mjs does.
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 30000);
    await sleep(2000);

    // ---------- Alt+Enter › Write Documentation, Google style detected ----------
    await h.caret('def area(', 6);
    check(await h.altEnter('Write Documentation'), 'Alt+Enter on a def name lists Write Documentation');
    check(await h.exists('.action-widget [role="option"]', 'Generate Unit Tests'), 'Alt+Enter on a def name lists Generate Unit Tests');
    await h.clickText('.action-widget [role="option"]', 'Write Documentation');
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'docstring review', 20000);
    const call1 = h.lastCall();
    check(call1.kind === 'docstring' && call1.stdin.includes('Docstring format: Google') && call1.stdin.includes('Target: function area'), 'the prompt asks for a Google docstring (detected from geometry.py) for area');
    check(call1.stdin.includes('<imports>\nimport math\n</imports>') && call1.stdin.includes('raise ValueError("negative size")')
      && !call1.stdin.includes('circle_area') && !call1.stdin.includes('class Rect') && !call1.stdin.includes('def checked'),
    'only the function and the module imports are sent');
    const sigLine = call1.stdin.match(/^Signature \(JSON\): (.*)$/m)?.[1];
    check(sigLine && JSON.parse(sigLine).raises[0] === 'ValueError' && JSON.parse(sigLine).returns === 'float', 'the signature, type hints and raises reach the prompt');
    const GOOGLE = ['    """Summary of area.', '', '    Args:', '        width (float): The width value.', '        height (float): The height value.', '',
      '    Returns:', '        float: The result.', '', '    Raises:', '        ValueError: If the input is invalid.', '    """'];
    const r1 = await h.review();
    const defLine = await h.lineOf('def area(');
    check(r1.hunks.length === 1 && r1.hunks[0].oldLines.length === 0 && r1.region.start === defLine + 1 && J(r1.hunks[0].newLines) === J(GOOGLE),
      'the docstring is an inline diff right below the def line, indented, in Google style');
    check((await h.text()) === SHAPES, 'nothing is written before Accept');
    check((await h.state()).last.format === 'google' && (await h.state()).last.formatSource === 'detected', 'the format came from the project (auto-detect)');
    await shot('docstring-review.png');
    await press('Ctrl+Enter');
    await until(`!ide.aiEdit.session()`, 'accepted');
    const afterArea = SHAPES.replace('def area(width: float, height: float) -> float:\n', `def area(width: float, height: float) -> float:\n${GOOGLE.join('\n')}\n`);
    check((await h.text()) === afterArea, 'Accept inserts the docstring');

    // ---------- reST when configured; a class docstring from the context menu ----------
    await js(`(ide.settings.set('python.docstringFormat', 'restructuredtext'), true)`);
    const classLine = await h.caret('class Rect', 7);
    await h.contextMenu(classLine);
    await clickMenuPath(t, ['AI', 'AI Actions…']);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((n) => n.textContent.includes('Write Documentation'))`, 'AI Actions popup');
    await h.clickText('.context-menu .menu-item', 'Write Documentation');
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'class docstring review', 20000);
    const REST_CLASS = ['    """Summary of Rect.', '', '    :param width: The width value.', '    :type width: float', '    :param height: The height value.', '    :type height: float', '    """'];
    const r2 = await h.review();
    check(h.lastCall().stdin.includes('Docstring format: reStructuredText') && h.lastCall().stdin.includes('Target: class Rect') && J(r2.hunks[0]?.newLines) === J(REST_CLASS),
      'with the setting on reStructuredText, the class docstring documents __init__\'s parameters in reST');
    await h.clickText('.ai-hunk-accept');
    await until(`!ide.aiEdit.session()`, 'class accepted');
    check((await h.text()).includes(`class Rect:\n${REST_CLASS.join('\n')}\n    def __init__`), 'the class docstring is inserted under the class line');

    // ---------- replacing an existing docstring needs a confirmation ----------
    const before = calls().length;
    await h.caret('def circle_area(', 6);
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent === 'Replace Docstring?')`, 'replace question');
    await h.clickText('.dialog-buttons button', 'Cancel');
    await sleep(800);
    check(calls().length === before && !(await h.review()), 'Cancel on "Replace Docstring?" sends nothing');
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent === 'Replace Docstring?')`, 'replace question again');
    await h.clickText('.dialog-buttons button', 'Replace');
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'replacement review', 20000);
    const oldStart = await h.lineOf('    """Old docstring.');
    const r3 = await h.review();
    const REST_FN = ['    """Summary of circle_area.', '', '    :param radius: The radius value.', '    :type radius: float', '    :return: The result.', '    :rtype: float', '    """'];
    check(h.lastCall().stdin.includes('(it replaces the current one)') && r3.region.start === oldStart && r3.region.end === oldStart + 4
      && r3.hunks.flatMap((x) => x.newLines).join('\n').includes(':rtype: float'), 'after Replace, the old docstring\'s lines are the reviewed region');
    await press('Ctrl+Enter');
    await until(`!ide.aiEdit.session()`, 'replacement accepted');
    check((await h.text()).includes(`def circle_area(radius: float) -> float:\n${REST_FN.join('\n')}\n    return math.pi`) && !(await h.text()).includes('Old docstring'),
      'Accept replaces the old docstring');

    // ---------- tabs and ''' quotes: the file's own style ----------
    writeFileSync(path.join(project, 'legacy.py'), "def first(items):\n\t'''Return the first item.'''\n\treturn items[0]\n\n\ndef last(items):\n\treturn items[-1]\n");
    await openFile(t, 'legacy.py');
    await until(`ide.editor.getModel()?.getLineCount() >= 7`, 'legacy.py loaded');
    await h.caret('def last', 6);
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'legacy review', 20000);
    check(J((await h.review()).hunks[0]?.newLines) === J(["\t'''Summary of last.", '', '\t:param items: The items value.', "\t'''"]), 'the docstring uses the file\'s tab indentation and \'\'\' quotes');
    // Esc discards the proposal.
    await press('Escape');
    await until(`!ide.aiEdit.session()`, 'discarded');
    check(!(await h.text()).includes('Summary of last'), 'Esc discards the docstring and leaves the file as it was');

    // ---------- Korean ----------
    await openFile(t, 'korean.py');
    await until(`ide.editor.getModel()?.getValue().includes('farewell')`, 'korean.py loaded');
    await h.caret('def farewell', 6);
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`ide.aiEdit.session()?.phase === 'reviewing'`, 'Korean review', 20000);
    await press('Ctrl+Enter');
    await until(`!ide.aiEdit.session()`, 'Korean accepted');
    check(h.lastCall().stdin.includes('Language: Korean') && (await h.text()).includes('def farewell(name: str) -> str:\n    """farewell 함수입니다.\n\n    :param name: name 값.\n    :type name: str\n    :return: 결과 값.\n    :rtype: str\n    """\n    return f"안녕히 가세요, {name}님"'),
      'a file with Korean comments gets a Korean docstring, intact through stdin and back');
    await js(`(ide.saveAll(), true)`);

    // ---------- Cancel from the background task ----------
    await openFile(t, 'shapes.py');
    scenario({ docstring: { delayMs: 30000 } });
    const nCalls = calls().length;
    await h.caret('    def __init__', 10);
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`ide.tasks.list().some((x) => x.title === 'Writing documentation for Rect.__init__' && x.cancellable)`, 'task shown');
    const waitCall = async () => { for (let i = 0; i < 100 && calls().length === nCalls; i++) await sleep(100); return calls().at(-1); };
    const pending = await waitCall();
    check(await js(`document.querySelector('#bgTasks')?.textContent.includes('Writing documentation for Rect.__init__')`), 'the request shows as a background task in the status bar');
    await js(`(ide.tasks.showPopup(), true)`);
    await until(`!!document.querySelector('#bgTasksPopup .bg-popup-cancel')`, 'tasks popup');
    await h.clickText('#bgTasksPopup .bg-popup-cancel');
    await until(`!ide.tasks.list().length && ide.aiGenerate.state().last?.code === 'cancelled'`, 'cancelled');
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) { gone = !alive(pending.pid); if (!gone) await sleep(100); }
    await sleep(500);
    check(gone && !(await h.review()) && !(await h.balloon('failed')), 'Cancel stops Claude Code\'s process, and nothing is shown or written');
    await press('Escape');

    // ---------- errors are notifications ----------
    scenario({ docstring: { error: 'Not logged in · Please run /login' } });
    await h.caret('    def __init__', 10);
    await js(`(ide.aiGenerate.writeDocumentation(), true)`);
    await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Write Documentation failed'))`, 'error balloon', 20000);
    check(await h.balloon('Claude Code is not signed in') && await h.balloon('Sign in to Claude Code'), 'a failed request is an error notification with Sign in to Claude Code');
    scenario({});

    // ---------- Generate Unit Tests: append to tests/test_shapes.py ----------
    const testFile = path.join(project, 'tests', 'test_shapes.py');
    const OLD_TESTS = nl(readFileSync(testFile, 'utf8'));
    await h.caret('    def area(self)', 9);
    check(await h.altEnter('Generate Unit Tests'), 'Alt+Enter on a method lists Generate Unit Tests');
    await h.clickText('.action-widget [role="option"]', 'Generate Unit Tests');
    await until(`!!ide.aiGenerate.state().preview && !!document.querySelector('.aig-preview .aig-write')`, 'preview tab', 20000);
    const tcall = h.lastCall();
    check(tcall.kind === 'tests' && tcall.stdin.includes('Framework: pytest') && tcall.stdin.includes('Import: from shapes import Rect')
      && tcall.stdin.includes('Existing tests in the file (do not reuse these names): test_area') && tcall.stdin.includes('<class>\nclass Rect:')
      && tcall.stdin.includes('<helper name="Rect.__init__">') && tcall.stdin.includes('<helper name="area">') && !tcall.stdin.includes('def checked'),
    'the tests prompt has the framework, the import, the existing names, the class header and the helpers it calls, and nothing else');
    const p1 = (await h.state()).preview;
    const TESTS1 = `${OLD_TESTS}\n\ndef test_area_2():\n    assert Rect(2, 3).area() == 6\n`;
    check(p1.testRel === 'tests/test_shapes.py' && nl(p1.after) === TESTS1 && J(p1.renamed) === J([{ from: 'test_area', to: 'test_area_2' }]),
      'the preview appends the new test and renames it to avoid a clash with test_area');
    check(await js(`ide.activeTab()?.title === 'Preview: test_shapes.py' && !!document.querySelector('.aig-preview .monaco-diff-editor')`), 'the preview is a tab with a diff');
    check(nl(readFileSync(testFile, 'utf8')) === OLD_TESTS, 'the test file is not written before Append');
    await shot('tests-preview.png');
    await h.clickText('.aig-preview .aig-write');
    await until(`!ide.aiGenerate.state().preview && ide.activeTab()?.path.endsWith('test_shapes.py')`, 'written and opened');
    check(nl(readFileSync(testFile, 'utf8')) === TESTS1, 'Append to File writes exactly the previewed text and opens the file');
    check(await h.balloon('Tests generated') && await h.balloon('Run Tests'), 'a notification offers Run Tests');

    // checked(): pytest.raises and a new import, from the context menu (the test file is open now).
    await openFile(t, 'shapes.py');
    const checkedLine = await h.caret('def checked', 6);
    await h.contextMenu(checkedLine);
    await clickMenuPath(t, ['AI', 'AI Actions…']);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((n) => n.textContent.includes('Generate Unit Tests'))`, 'AI Actions popup (tests)');
    await h.clickText('.context-menu .menu-item', 'Generate Unit Tests');
    await until(`!!document.querySelector('.aig-preview .aig-write')`, 'preview 2', 20000);
    await h.clickText('.aig-preview .aig-write');
    await until(`!ide.aiGenerate.state().preview`, 'written 2');
    const TESTS2 = TESTS1.replace('from shapes import Rect\n', 'from shapes import Rect\nimport pytest\nfrom shapes import checked\n')
      + '\n\ndef test_checked():\n    assert checked(3) == 3\n\n\ndef test_checked_raises_valueerror():\n    with pytest.raises(ValueError):\n        checked(-1)\n';
    check(nl(readFileSync(testFile, 'utf8')) === TESTS2, 'an open test file gets the new imports after its own and the tests appended, and is saved');

    // Cancel in the preview writes nothing.
    await openFile(t, 'shapes.py');
    await h.caret('def circle_area(', 6);
    await js(`(ide.aiGenerate.generateTests(), true)`);
    await until(`!!document.querySelector('.aig-preview .aig-cancel')`, 'preview 3', 20000);
    await h.clickText('.aig-preview .aig-cancel');
    await until(`!document.querySelector('.aig-preview')`, 'preview closed');
    check(nl(readFileSync(testFile, 'utf8')) === TESTS2, 'Cancel in the preview leaves the test file alone');

    // Korean strings in a new test file, then Run Tests from the notification.
    await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);
    await openFile(t, 'korean.py');
    await h.caret('def greet', 6);
    await js(`(ide.aiGenerate.generateTests(), true)`);
    await until(`!!document.querySelector('.aig-preview .aig-write')`, 'preview korean', 20000);
    check(await js(`document.querySelector('.aig-preview .aig-write').textContent === 'Create File'`), 'a new test file is offered as Create File');
    await h.clickText('.aig-preview .aig-write');
    await until(`!ide.aiGenerate.state().preview`, 'written korean');
    const KO = path.join(project, 'tests', 'test_korean.py');
    const newSep = await js('ide.lineSeparators.newFile()');
    check(existsSync(KO) && readFileSync(KO, 'utf8') === 'from korean import greet\n\n\ndef test_greet():\n    assert greet("철수") == \'안녕하세요, 철수님\'\n'.replace(/\n/g, newSep),
      `a new tests/test_korean.py with Korean strings intact, written with the new-file line separator (${J(newSep)})`);
    await until(`[...document.querySelectorAll('.ide-balloon-action')].some((n) => n.textContent === 'Run Tests')`, 'Run Tests button');
    await h.clickText('.ide-balloon-action', 'Run Tests');
    await waitTests(t, 'korean tests ran');
    check((await testStatus(t)).includes('Tests passed: 1 of 1 test'), `Run Tests runs the generated Korean test and it passes (${await testStatus(t)})`);
    await js(`(ide.aiGenerate.runTests(${J(testFile)}), true)`);
    await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in test_shapes.py'`, 'shapes test tab');
    await waitTests(t, 'shapes tests ran');
    check((await testStatus(t)).includes('Tests passed: 4 of 4 tests'), `the appended tests pass with pytest, the old one too (${await testStatus(t)})`);

    // ---------- the settings page and the IDE log ----------
    await js(`(ide.openSettings('python-tests'), true)`);
    await until(`[...document.querySelectorAll('.settings-main')].some((n) => n.textContent.includes('Docstring format:'))`, 'settings section');
    check(await js(`[...document.querySelectorAll('.settings-main select')].some((s) => [...s.options].map((o) => o.textContent).join() === 'Auto-detect,reStructuredText,Google,NumPy,Plain')`),
      'Settings › Python Integrated Tools has the Docstring format choice (Auto-detect, reST, Google, NumPy, Plain)');
    await press('Escape');
    let logged = '';
    for (let i = 0; i < 30 && !logged.includes('Generate Unit Tests for shapes.py:Rect.area'); i++) { logged = logText(t); await sleep(200); }
    check(/DEBUG - #ai-generate - Generate Unit Tests for shapes\.py:Rect\.area: sent \d+ characters/.test(logged) && logged.includes('Import: from shapes import Rect'),
      'at DEBUG level the IDE log shows what was sent');
  } catch (err) {
    console.log(`FAIL ${err.message}`);
    t.results.push({ ok: false });
    await shot('failure-a.png').catch(() => {});
  }
  failedApp ||= t.results.some((r) => !r.ok) || t.consoleErrors.length > 0;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
}

// ===================================================================== B: src layout, Korean UI, INFO log
{
  const t = await launch({ fixture: 'ai-generate-src', port: 9011, name: 'ai-generate-src', lang: 'ko-KR' });
  const { js, until, check, shot, project } = t;
  const h = await helpers(t);
  try {
    await openFile(t, 'src/shop/cart.py');
    await until(`ide.editor.getModel()?.getValue().includes('def total')`, 'cart.py loaded');
    await h.caret('def total', 6);
    await js(`(ide.aiGenerate.generateTests(), true)`);
    await until(`!!document.querySelector('.aig-preview .aig-write')`, 'src preview', 20000);
    const p = (await h.state()).preview;
    check(p.testRel === 'tests/test_cart.py' && p.importLine === 'from shop.cart import total' && !p.notes.length && !p.exists,
      `src layout: tests/test_cart.py imports from shop.cart (${p.importLine})`);
    check(await js(`document.querySelector('.aig-preview .aig-write').textContent === '파일 생성' && ide.activeTab()?.title === '미리보기: test_cart.py'`), 'the preview is in Korean');
    const leaks = await englishLeaks(t, '.aig-preview .aig-bar');
    check(!leaks.length, `no English in the Korean preview bar (${leaks.join(' | ')})`);
    await shot('src-preview-ko.png');
    await h.clickText('.aig-preview .aig-write');
    await until(`!ide.aiGenerate.state().preview`, 'src written');
    const testFile = path.join(project, 'tests', 'test_cart.py');
    check(nl(readFileSync(testFile, 'utf8')) === 'import pytest\n\nfrom shop.cart import total\n\n\ndef test_total():\n    assert total([1.5, 2.5]) == 4.0\n\n\ndef test_total_raises_valueerror():\n    with pytest.raises(ValueError):\n        total([-1.0])\n',
      'the src-layout test file has the pytest import and both tests');
    await js(`(ide.aiGenerate.runTests(${J(testFile)}), true)`);
    await waitTests(t, 'src tests ran');
    check((await testStatus(t)).includes('테스트 통과: 2 / 총 2개 테스트'), `the generated src-layout tests pass with pytest (${await testStatus(t)})`);
    const ko = await missingTranslations(t);
    const mine = ko.filter((s) => readFileSync(path.join(APP, 'renderer', 'features', 'ai-generate', 'index.js'), 'utf8').includes(J(s).slice(1, -1)));
    check(!mine.length, `every ai-generate string has a Korean translation (${mine.join(' | ')})`);
    await sleep(500);
    check(!logText(t).includes('Generate Unit Tests for src/shop/cart.py') && !logText(t).includes('Import: from shop.cart'), 'at the default INFO level the prompt is not logged');
  } catch (err) {
    console.log(`FAIL ${err.message}`);
    t.results.push({ ok: false });
    await shot('failure-b.png').catch(() => {});
  }
  failedApp ||= t.results.some((r) => !r.ok) || t.consoleErrors.length > 0;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
}

// ===================================================================== C: an untrusted project in Safe Mode
{
  const work = mkdtempSync(path.join(tmpdir(), 'pyide-ai-generate-safe-'));
  const home = path.join(work, 'home');
  const untrusted = path.join(work, 'downloaded');
  cpSync(path.join(APP, 'verify', 'fixtures', 'ai-generate'), home, { recursive: true });
  cpSync(path.join(APP, 'verify', 'fixtures', 'ai-generate'), untrusted, { recursive: true });
  const userData = path.join(work, 'userdata');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'settings.json'), J({ recentProjects: [{ path: home, opened: Date.now() }] }));
  const t = await launch({ fixture: 'ai-generate', port: 9012, name: 'ai-generate-safe', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } });
  const { js, until, check } = t;
  const h = await helpers(t);
  try {
    js(`ide.openProject(${J(untrusted)})`).catch(() => {});
    await until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent === 'Trust and Open Project?')`, 'trust question');
    await h.clickText('.dialog-buttons button', 'Preview in Safe Mode');
    await until(`ide.root && ide.util.samePath(ide.root, ${J(untrusted)}) && ide.trusted === false`, 'Safe Mode');
    await sleep(800);
    await openFile(t, 'shapes.py');
    await until(`ide.editor.getModel()?.getLineCount() > 30`, 'shapes.py loaded (safe)');
    const n0 = calls().length;
    const line = await h.caret('def area(', 6);
    await h.contextMenu(line);
    await clickMenuPath(t, ['AI', 'AI Actions…']);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((n) => n.textContent.includes('Write Documentation'))`, 'AI Actions popup (safe)');
    check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].filter((n) => /Write Documentation|Generate Unit Tests/.test(n.textContent)).every((n) => n.classList.contains('disabled') && n.textContent.includes('Safe Mode'))`),
      'in Safe Mode the AI Actions are disabled with a note');
    await t.press('Escape');
    await js(`(ide.aiGenerate.generateTests(), true)`);
    await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Not available in Safe Mode'))`, 'Safe Mode note');
    check(true, 'running an AI action in Safe Mode explains it and offers Trust Project');
    const refused = await js(`ide.api.invoke('ai-generate:docstring', { reqId: 'x', root: ide.root, path: ide.util.joinPath(ide.root, 'shapes.py'), text: 'def f(x):\\n    return x\\n', line: 1, model: 'haiku', format: '' })`);
    const refused2 = await js(`ide.api.invoke('ai-generate:writeTests', { root: ide.root, testPath: ide.util.joinPath(ide.root, 'tests', 'test_x.py'), before: null, after: 'x = 1\\n' })`);
    check(refused.code === 'untrusted' && refused2.code === 'untrusted' && !existsSync(path.join(untrusted, 'tests', 'test_x.py')), 'the main process refuses an untrusted project');
    await sleep(500);
    check(calls().length === n0, 'nothing reached Claude Code from the untrusted project');
  } catch (err) {
    console.log(`FAIL ${err.message}`);
    t.results.push({ ok: false });
  }
  failedApp ||= t.results.some((r) => !r.ok) || t.consoleErrors.length > 0;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
}

const unitFailed = unit.filter((x) => !x).length;
console.log(`unit: ${unit.length - unitFailed}/${unit.length} passed`);
process.exit(unitFailed || failedApp ? 1 : 0);
