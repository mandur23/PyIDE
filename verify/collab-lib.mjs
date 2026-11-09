// Two Nano Studio Code instances in one collaboration session, for the collab-*.mjs suites: a host and a guest, each
// with its own CDP port and user data, connected on loopback through a stand-in of bore.pub (verify/stand-in-bore.mjs,
// relaying for real) and the real main/bore-client.js under Electron, as in the app. Nothing reaches bore.pub: the bore
// client is sent to the stand-in, and exits when an argument still names bore.pub. Not a test: suites import it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir, clickMenuPath } from './lib.mjs';
import { standInBore } from './stand-in-bore.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const S = JSON.stringify;
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// opts: {name, ports: [host, guest], host: {fixture, lang, env, setup(projectDir)}, guest: {...}, latency}
export async function collabPair({ name, ports, host = {}, guest = {}, latency = null }) {
  const work = tempDir(name);
  const bore = standInBore({ relay: true, latency });
  await new Promise((resolve) => { bore.server.listen(0, '127.0.0.1', resolve); });
  const borePick = path.join(work, 'bore-pick.cjs');
  const boreLog = path.join(work, 'bore-args.log');
  writeFileSync(borePick, `require('fs').appendFileSync(${S(boreLog)}, process.argv.slice(2).join(' ') + '\\n');
const to = process.argv.indexOf('--to');
if (process.argv[to + 1] === 'bore.pub') process.argv[to + 1] = '127.0.0.1';
if (process.argv.includes('bore.pub')) process.exit(9);
process.env.PYIDE_BORE_CONTROL_PORT = ${S(String(bore.server.address().port))};
require(${S(path.join(APP_DIR, 'main', 'bore-client.js'))});
`);
  const env = { PYIDE_BORE: S([ELECTRON, borePick]), PYIDE_COLLAB_TEST: '1' };
  const [h, g] = await Promise.all([
    launch({ fixture: host.fixture || 'core', port: ports[0], name: `${name}-host`, lang: host.lang || 'en-US', env: { ...env, ...host.env } }),
    launch({ fixture: guest.fixture || 'core', port: ports[1], name: `${name}-guest`, lang: guest.lang || 'en-US', env: { ...env, ...guest.env } }),
  ]);
  const check = h.check;
  const section = async (label, fn) => { try { await fn(); } catch (err) { check(false, `${label}: ${err.message.split('\n')[0]}`); } };

  // The topmost dialog's button with this text, pressed with the mouse.
  async function pressButton(ctx, text, { primary = false } = {}) {
    const sel = '[data-collab-test-target]';
    await ctx.until(`(() => { const box = [...document.querySelectorAll('#dialogHost .dialog')].pop(); const b = box && [...box.querySelectorAll('.dialog-buttons button')].find((x) => ${primary ? "x.classList.contains('primary')" : `x.textContent === ${S(text)}`}); if (!b) return false; document.querySelectorAll(${S(sel)}).forEach((n) => n.removeAttribute('data-collab-test-target')); b.setAttribute('data-collab-test-target', '1'); return true; })()`, `dialog button ${text}`);
    await ctx.click(sel);
  }
  // An element found by a page expression, pressed with the mouse.
  async function pressNode(ctx, expr, label) {
    await ctx.until(`(() => { const n = ${expr}; if (!n) return false; document.querySelectorAll('[data-collab-test-target]').forEach((x) => x.removeAttribute('data-collab-test-target')); n.setAttribute('data-collab-test-target', '1'); n.scrollIntoView({ block: 'nearest' }); return true; })()`, label);
    await ctx.click('[data-collab-test-target]');
  }
  // Types into a field of the topmost dialog, as a user does: a click into it, Ctrl+A, then the text.
  async function fill(ctx, selector, text) {
    await ctx.until(`!!document.querySelector(${S(selector)})`, `field ${selector}`);
    await ctx.click(selector);
    await ctx.press('Ctrl+a');
    await ctx.type(text);
  }

  // The host starts a session from Tools in the main menu -> the join code.
  async function start({ name: who = 'Hana', mode = null } = {}) {
    await h.js(`(ide.on('clipboardWritten', (t) => { window.__collabCopied = t; }), true)`);
    await h.click('#mainMenuBtn');
    await clickMenuPath(h, ['Tools', 'Start Collaboration Session…']);
    await fill(h, '.collab-form .collab-name', who);
    if (mode) await h.js(`(document.querySelector('.collab-form .collab-mode').value = ${S(mode)}, true)`);
    await pressButton(h, 'Start', { primary: true });
    await h.until(`!!ide.collab.state().code`, 'the session code', 30000);
    return h.js(`ide.collab.state().code`);
  }
  // The guest joins with the code; the host answers the request with the button `answer` (or none: null).
  async function join(code, { name: who = 'Min', answer = 'Accept (View Only)', fromWelcome = false } = {}) {
    if (fromWelcome) await g.click('#welcomeCollab');
    else await g.js(`(ide.runAction('Collab.Join'), true)`);
    await fill(g, '.collab-form .collab-code', code);
    await fill(g, '.collab-form .collab-name', who);
    await pressButton(g, 'Join', { primary: true });
    if (!answer) return;
    await h.until(`[...document.querySelectorAll('#dialogHost .dialog-message')].some((n) => n.textContent.includes(${S(who)}))`, 'the request to join', 20000);
    await pressButton(h, answer);
    if (answer.startsWith('Accept')) await g.until(`ide.collab.state().info?.you > 0 && !document.querySelector('#dialogHost .collab-form')`, 'joined, the dialog closed', 20000);
  }
  const borePort = () => bore.publicPort;
  const boreArgs = () => (existsSync(boreLog) ? readFileSync(boreLog, 'utf8') : '');

  // Every file under dir, as long as it is small, that holds `needle`: what a guest must not have written.
  function filesHolding(dir, needle) {
    const out = [];
    const walk = (d, depth = 0) => {
      let entries = [];
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 12) walk(p, depth + 1); continue; }
        try { if (statSync(p).size < 32 << 20 && readFileSync(p).includes(needle)) out.push(p); } catch {}
      }
    };
    walk(dir);
    return out;
  }

  function finish() {
    check(!g.consoleErrors.length, `guest: no renderer exceptions${g.consoleErrors.length ? `: ${g.consoleErrors.join(' | ')}` : ''}`);
    check(!g.cspViolations.length, `guest: no CSP violations${g.cspViolations.length ? `: ${g.cspViolations.join(' | ')}` : ''}`);
    g.close();
    bore.close();
    bore.server.close();
    h.finish();
  }
  return { h, g, work, bore, check, section, pressButton, pressNode, fill, start, join, borePort, boreArgs, filesHolding, finish };
}
