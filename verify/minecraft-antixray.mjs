// Anti-xray's main-process core in plain Node: no Electron, no window, no real server. The fixture has the shape of a real
// Paper 26.3 config/paper-world-defaults.yml (header, _version, the block with Paper's defaults, other sections), read
// from a real server once and rewritten here. What Paper does with the edited file is not proven here.
// Checks: the docs' lists and levels; the line edit (only the block's keys change, comments, order, unknown keys, CRLF, a
// BOM and a missing last newline stay, bracket lists, idempotence, every unexpected shape refused and nothing written);
// the server's files (26.x and older folders, level-name, allow-nether, the End, a new paper-world.yml, an overworld
// override, a hostile level-name); status for each kind; the backup; atomic writes (a failed rename leaves every file as it
// was, a leftover temporary file is harmless); assign and settle for "apply to my other servers" and a waiting level.
// Usage: node verify/minecraft-antixray.mjs
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const xray = require('../main/minecraft/anti-xray.js');
const { edit, readBlock, wanted, levelsFor, supportOf, newServerLevel, status, planned, commit, assign, settle, BACKUP } = xray;

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const J = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-antixray-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
let serial = 0;
const write = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
const read = (p) => readFileSync(p, 'utf8');
const refusal = (step) => { try { step(); return null; } catch (err) { return err.refusal ?? `threw ${err.message}`; } };

const PAPER_HIDDEN = ['copper_ore', 'deepslate_copper_ore', 'raw_copper_block', 'gold_ore', 'deepslate_gold_ore', 'iron_ore', 'deepslate_iron_ore', 'raw_iron_block',
  'coal_ore', 'deepslate_coal_ore', 'lapis_ore', 'deepslate_lapis_ore', 'mossy_cobblestone', 'obsidian', 'chest', 'diamond_ore', 'deepslate_diamond_ore', 'redstone_ore',
  'deepslate_redstone_ore', 'clay', 'emerald_ore', 'deepslate_emerald_ore', 'ender_chest'];
const BLOCK = `anticheat:
  anti-xray:
    enabled: false
    engine-mode: 1
    hidden-blocks:
${PAPER_HIDDEN.map((b) => `    - ${b}`).join('\n')}
    lava-obscures: false
    max-block-height: 64
    replacement-blocks:
    - stone
    - oak_planks
    - deepslate
    update-radius: 2
    use-permission: false
`;
const HEAD = `# This is the world defaults configuration file for Paper.
# As you can see, there's a lot to configure. Some options may impact gameplay, so use
# with caution, and make sure you know what each option does before configuring.
#
# Configuration options here apply to all worlds, unless you specify overrides inside
# the world-specific config file inside each world folder.
#
# File Reference: https://docs.papermc.io/paper/reference/world-configuration/
# Docs: https://docs.papermc.io/

_version: 31
`;
const TAIL = `chunks:
  auto-save-interval: default
  delay-chunk-unloads-by: 10s
  entity-per-chunk-save-limit:
    arrow: -1
    ender_pearl: -1
collisions:
  allow-player-cramming-damage: false
entities:
  behavior:
    door-breaking-difficulty:
      husk:
      - HARD
      vindicator:
      - NORMAL
      - HARD
  spawning:
    filtered-entity-tag-nbt-paths:
    - Pos
    - Motion
    - sleeping_pos
unsupported-settings:
  disable-world-ticking-when-empty: false
`;
const REAL = `${HEAD}${BLOCK}${TAIL}`;
const WORLD_HEADER = '# This is a world configuration file for Paper.\n# World: world (minecraft:the_nether)\n\n_version: 31\n';

// ---------- levels ----------
check(J(wanted('off', 'overworld')) === '{"enabled":false}', 'Off only turns it off, and keeps the lists');
check(wanted('basic', 'overworld')['engine-mode'] === 1 && wanted('strong', 'overworld')['engine-mode'] === 2 && wanted('layers', 'overworld')['engine-mode'] === 3, 'the levels are engine-modes 1, 2 and 3');
check(wanted('basic', 'overworld')['max-block-height'] === 64 && wanted('basic', 'nether')['max-block-height'] === 128 && wanted('strong', 'nether')['max-block-height'] === 128, 'the heights are the docs\' 64 and 128');
check(wanted('basic', 'overworld')['hidden-blocks'].length === 19 && wanted('strong', 'overworld')['hidden-blocks'].length === 15 && wanted('strong', 'overworld')['replacement-blocks'].length === 18,
  'the overworld lists have the docs\' 19, 15 and 18 blocks');
check(J(wanted('basic', 'nether')['hidden-blocks']) === J(['ancient_debris', 'nether_gold_ore', 'nether_quartz_ore']) && wanted('strong', 'nether')['hidden-blocks'].length === 9
  && wanted('strong', 'nether')['replacement-blocks'].includes('netherrack'), 'the Nether has its own lists');
check(!wanted('strong', 'overworld')['hidden-blocks'].includes('chest') && wanted('strong', 'overworld')['replacement-blocks'].includes('chest'), 'a chest, a tile entity, is never a fake block in mode 2');
check(!('replacement-blocks' in wanted('basic', 'overworld')), 'Basic leaves replacement-blocks, which mode 1 does not use');
check(J(wanted('strong', 'end')) === '{"enabled":false}', 'the End stays off at every level, as the docs say');
check(J(wanted('strong', 'overworld')['hidden-blocks']) === J(wanted('layers', 'overworld')['hidden-blocks']), 'mode 3 uses mode 2\'s lists');
check(!levelsFor('1.21.3').includes('layers') && !levelsFor('1.19.4').includes('layers') && levelsFor('1.21.4').includes('layers') && levelsFor('1.21.11').includes('layers') && levelsFor('26.3').includes('layers'),
  'engine-mode 3 is offered only from 1.21.4, the oldest Paper source that was read, because an unknown mode stops a server loading');
check(J(['paper', 'tooOld', 'tooOld', 'vanilla', 'modded', 'proxy'].join()) === J([supportOf({ plugins: 'paper', mc: '26.3' }), supportOf({ plugins: 'paper', mc: '1.18.2' }), supportOf({ plugins: 'paper' }),
  supportOf({ plugins: false, mc: '1.21.1' }), supportOf({ plugins: false, mods: 'forge', mc: '1.21.1' }), supportOf({ plugins: 'velocity', proxy: true, mc: '3.4.0' })].join()), 'each kind of server is told apart');
const newLevels = ['basic', 'strong', 'layers', 'off', '../x', undefined].map((l) => newServerLevel({ plugins: 'paper', mc: '26.3' }, l));
check(J(newLevels) === J(['basic', 'strong', null, null, null, null]), `a new server takes Basic or Strong from the default and nothing else (${J(newLevels)})`);
check(newServerLevel({ plugins: false, mc: '1.21.1' }, 'basic') === null && newServerLevel({ plugins: false, mods: 'fabric', mc: '1.21.1' }, 'strong') === null
  && newServerLevel({ plugins: 'velocity', proxy: true, mc: '3.4.0' }, 'basic') === null && newServerLevel({ plugins: 'paper', mc: '1.18.2' }, 'basic') === null, 'a new server of another kind gets nothing waiting');

// ---------- the line edit ----------
const outside = (text) => { const s = text.indexOf('anticheat:'); const e = text.indexOf('chunks:'); return text.slice(0, s) + text.slice(e); };
const basic = edit(REAL, wanted('basic', 'overworld'), false);
check(outside(basic) === `${HEAD}${TAIL}`, 'everything outside the block is byte for byte the same');
check(basic.startsWith('# This is the world defaults') && /# Docs: https:/.test(basic) && /_version: 31/.test(basic), 'the header comments and _version stay');
const got = readBlock(basic);
check(got.enabled === true && got['engine-mode'] === 1 && got['max-block-height'] === 64, 'Basic reads back: enabled, engine-mode 1, height 64');
check(new Set(got['hidden-blocks']).size === 19 && wanted('basic', 'overworld')['hidden-blocks'].every((b) => got['hidden-blocks'].includes(b)), 'Basic reads back: the docs\' hidden list');
check(/ {4}lava-obscures: false\n/.test(basic) && / {4}update-radius: 2\n/.test(basic) && / {4}use-permission: false\n/.test(basic) && J(got['replacement-blocks']) === J(['stone', 'oak_planks', 'deepslate']), 'keys a level does not set keep their values');
const strong = edit(basic, wanted('strong', 'overworld'), false);
const s = readBlock(strong);
check(s['engine-mode'] === 2 && new Set(s['hidden-blocks']).size === 15 && s['hidden-blocks'].includes('air') && new Set(s['replacement-blocks']).size === 18 && outside(strong) === `${HEAD}${TAIL}`, 'Strong sets its lists from a Basic file, and the rest stays');
const order = (t) => [...t.matchAll(/^ {4}([a-z-]+):/gm)].map((m) => m[1]).join();
check(order(strong) === order(REAL), 'the keys stay in their order');
const off = edit(strong, wanted('off', 'overworld'), false);
check(readBlock(off).enabled === false && readBlock(off)['engine-mode'] === 2 && new Set(readBlock(off)['hidden-blocks']).size === 15, 'Off changes one line');
check(edit(basic, wanted('basic', 'overworld'), false) === basic && edit(strong, wanted('strong', 'overworld'), false) === strong && edit(off, wanted('off', 'overworld'), false) === off, 'each level written twice is the same text');

const noted = REAL.replace('    enabled: false\n', '    # the owner: keep this off during events\n    enabled: false # switched by hand\n')
  .replace('    - gold_ore\n', '    # valuables\n    - gold_ore\n').replace('    update-radius: 2\n', '    update-radius: 1\n    future-key: 7\n    future-map:\n      nested: yes\n      other:\n      - a\n');
const notedOut = edit(noted, wanted('strong', 'overworld'), false);
check(/ {4}# the owner: keep this off during events\n {4}enabled: true # switched by hand\n/.test(notedOut), 'a comment above a key and the note after its value stay');
check(/ {4}# valuables\n/.test(notedOut), 'a comment inside a list stays');
check(/ {4}update-radius: 1\n {4}future-key: 7\n {4}future-map:\n {6}nested: yes\n {6}other:\n {6}- a\n/.test(notedOut), 'unknown keys and the owner\'s update-radius stay');
check(readBlock(notedOut).enabled === true && !readBlock(notedOut)['hidden-blocks'].includes('clay') && readBlock(notedOut)['hidden-blocks'].includes('gold_ore'), 'the list changed around the comment');

const crlf = REAL.replace(/\n/g, '\r\n');
const crlfOut = edit(crlf, wanted('strong', 'overworld'), false);
check(!/[^\r]\n/.test(crlfOut) && readBlock(crlfOut)['engine-mode'] === 2 && crlfOut.endsWith('\r\n'), 'a CRLF file stays CRLF on every line');
const bomOut = edit(`\uFEFF${REAL}`, wanted('basic', 'overworld'), false);
check(bomOut.startsWith('\uFEFF#') && !bomOut.slice(1).includes('\uFEFF'), 'a byte order mark stays');
const bare = `_version: 31\nanticheat:\n  anti-xray:\n    enabled: false`;
const bareOut = edit(bare, wanted('basic', 'nether'), true);
check(!bareOut.endsWith('\n') && readBlock(bareOut)['max-block-height'] === 128 && readBlock(bareOut)['hidden-blocks'].length === 3, 'a file without a last newline is added to at its end');
const bareCrlf = edit(bare.replace(/\n/g, '\r\n'), wanted('basic', 'nether'), true);
check(!/[^\r]\n/.test(bareCrlf) && !bareCrlf.endsWith('\r') && readBlock(bareCrlf).enabled === true, 'and a CRLF one too, with no stray \\r at the end');

const inline = REAL.replace(/ {4}replacement-blocks:\n( {4}- .*\n)+/, '    replacement-blocks: []\n');
const inlineOut = edit(inline, wanted('strong', 'overworld'), false);
check(new Set(readBlock(inlineOut)['replacement-blocks']).size === 18 && !/replacement-blocks: \[\]/.test(inlineOut), 'an empty [] list is opened up');
check(J(readBlock(REAL.replace(/ {4}replacement-blocks:\n( {4}- .*\n)+/, '    replacement-blocks: [stone, "deepslate", minecraft:tuff]\n'))['replacement-blocks']) === J(['stone', 'deepslate', 'tuff']), 'a bracket list reads as its blocks');
check(edit(inline, { 'replacement-blocks': [] }, false) === inline, 'an empty list set to empty is the same text');
const emptied = edit(REAL, { 'replacement-blocks': [] }, false);
check(/ {4}replacement-blocks: \[\]\n {4}update-radius/.test(emptied), 'a list set to empty becomes []');
const dressed = REAL.replace('    - stone\n', '    - "minecraft:stone" # the base\n').replace('    - deepslate\n', "    - 'deepslate'\n");
check(edit(dressed, { 'replacement-blocks': ['stone', 'oak_planks', 'deepslate'] }, false) === dressed, 'quotes and minecraft: are the same block, so nothing is rewritten');
const missing = REAL.replace('    max-block-height: 64\n', '').replace('    use-permission: false\n', '');
const missingOut = edit(missing, wanted('basic', 'overworld'), false);
check(readBlock(missingOut)['max-block-height'] === 64 && missingOut.indexOf('max-block-height') < missingOut.indexOf('chunks:') && outside(missingOut) === `${HEAD}${TAIL}`, 'a missing key is added inside the block');

const empty = edit('', wanted('strong', 'end'), true);
check(J(readBlock(empty)) === '{"enabled":false}', 'an empty paper-world.yml gets the block');
const header = edit(WORLD_HEADER, wanted('basic', 'nether'), true);
check(header.startsWith(WORLD_HEADER) && /^anticheat:\n {2}anti-xray:\n {4}enabled: true\n/m.test(header), 'a paper-world.yml with only a header keeps it and gets the block after it');
const other = edit(`_version: 31\nanticheat:\n  obfuscation-other: 1\nchunks:\n  auto-save-interval: 5\n`, wanted('strong', 'nether'), true);
check(readBlock(other)['engine-mode'] === 2 && /obfuscation-other: 1\n {2}anti-xray:/.test(other) && other.endsWith('chunks:\n  auto-save-interval: 5\n'), 'an anticheat: section without anti-xray gets it, and the next section stays');
check(refusal(() => edit('_version: 31\nchunks:\n  a: 1\n', wanted('basic', 'overworld'), false)) === 'noBlock', 'the defaults file without the block is refused, not given one');

const shapes = {
  'a tab for indent': REAL.replace('    enabled: false', '\tenabled: false'),
  'anticheat with a value': REAL.replace('anticheat:\n', 'anticheat: {}\n'),
  'anti-xray written in braces': `_version: 31\nanticheat:\n  anti-xray: {enabled: true}\n`,
  'a quoted anticheat': REAL.replace('anticheat:\n', '"anticheat":\n'),
  'a quoted anti-xray': REAL.replace('  anti-xray:\n', "  'anti-xray':\n"),
  'a quoted key in the block': REAL.replace('    enabled: false', '    "enabled": false'),
  'anticheat twice': `${REAL}anticheat:\n  anti-xray:\n    enabled: true\n`,
  'anti-xray twice': REAL.replace('  anti-xray:\n', '  anti-xray:\n    enabled: true\n  anti-xray:\n'),
  'a key twice': REAL.replace('    enabled: false\n', '    enabled: false\n    enabled: true\n'),
  'a second document': `${REAL}---\nanticheat:\n`,
  'the whole file in braces': '{anticheat: {anti-xray: {enabled: false}}}\n',
  'keys out of line': REAL.replace('    engine-mode: 1\n', '      engine-mode: 1\n').replace('    enabled: false\n', '      enabled: false\n').replace('    hidden-blocks:\n', '   hidden-blocks:\n'),
  'an anchor on a list': REAL.replace('    hidden-blocks:\n', '    hidden-blocks: &ores\n'),
  'an alias as a list': REAL.replace(/ {4}hidden-blocks:\n( {4}- .*\n)+/, '    hidden-blocks: *ores\n'),
  'a map in a list': REAL.replace('    - copper_ore\n', '    - {name: copper_ore}\n'),
  'a key in a list': REAL.replace('    - copper_ore\n', '      nested: 1\n'),
  'a flag that is no boolean': REAL.replace('    enabled: false', '    enabled: "yes"'),
  'a mode that is no number': REAL.replace('    engine-mode: 1', '    engine-mode: hide'),
  'an indented root': '  _version: 31\n  chunks:\n    a: 1\n',
  'an indented root after a marker': '---\n  _version: 31\n',
  'a value on the document marker': '--- {_version: 31}\n',
  'a scalar on the document marker': '--- 31\n',
  'a list at the root': '- a\n- b\n',
  'a double-quoted text over several lines': `note: "first\n${BLOCK}the end: of it"\n`,
  'a single-quoted text over several lines': `note: 'it''s\n${BLOCK}the end: of it'\n`,
  'an open quote on a quoted key': `"a: b": "first\n${BLOCK}the end: of it"\n`,
  'an open quote in a list': `note:\n- "first\n${BLOCK}the end: of it"\n`,
  'an open quote in the block': REAL.replace('    update-radius: 2\n', '    note: "first\n    update-radius: 2\n    end: of it"\n'),
};
for (const [name, text] of Object.entries(shapes)) {
  const code = refusal(() => edit(text, wanted('strong', 'overworld'), true));
  check(code === 'shape', `refused: ${name}${code === 'shape' ? '' : ` (${code})`}`);
}

const fine = {
  'a document marker': `---\n${REAL}`,
  'a document marker with a note': `--- # Paper\n${REAL}`,
  'a quoted text that closes': `note: "a: b # c"\n${REAL}`,
  'a text with an apostrophe': `note: it's fine\n${REAL}`,
  'a single-quoted text with a doubled quote': `note: 'it''s fine'\n${REAL}`,
  'an escaped quote in a text': `note: "say \\"hi\\""\n${REAL}`,
  'a quoted key': `"a: b": "c"\n${REAL}`,
  'a quote after a note': `a: 1 # it's "here\n${REAL}`,
  'a comment with an open quote': `# don't "\n${REAL}`,
};
for (const [name, text] of Object.entries(fine)) {
  const code = refusal(() => edit(text, wanted('basic', 'overworld'), false));
  check(code === null, `still read: ${name}${code === null ? '' : ` (${code})`}`);
}
const noBlockOut = edit('---\n_version: 31\n', wanted('basic', 'nether'), true);
check(/^---\n_version: 31\nanticheat:\n/.test(noBlockOut), 'a file with a bare document marker gets the block at column 0, under a map that starts there');

// ---------- a server's files ----------
const PAPER26 = { plugins: 'paper', mods: null, proxy: false, mc: '26.3' };
const PAPER21 = { plugins: 'paper', mods: null, proxy: false, mc: '1.21.1' };
function server({ mc = '26.3', config = REAL, props = 'server-port=25565\n', files = {} } = {}) {
  const dir = path.join(work, `s${++serial}`);
  mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'server.properties'), props);
  if (config !== null) write(path.join(dir, 'config', 'paper-world-defaults.yml'), config);
  for (const [f, text] of Object.entries(files)) write(path.join(dir, f), text);
  return { dir, srv: { ...PAPER26, mc } };
}
const NETHER26 = 'world/dimensions/minecraft/the_nether/paper-world.yml';
const END26 = 'world/dimensions/minecraft/the_end/paper-world.yml';
const apply = (a, level) => {
  const p = planned(a.dir, a.srv, level);
  if (p.refused) throw new Error(J(p.refused));
  const refused = commit(p.changes);
  if (refused) throw Object.assign(new Error(refused.detail), { refused });
  return p.changes.length;
};
const defaultsOf = (a) => path.join(a.dir, 'config', 'paper-world-defaults.yml');
const treeOf = (dir) => readdirSync(dir, { recursive: true }).map(String).sort();
const stateOf = (dir) => Object.fromEntries(treeOf(dir).filter((f) => statSync(path.join(dir, f)).isFile()).map((f) => [f, read(path.join(dir, f))]));

{
  const a = server({ files: { [NETHER26]: WORLD_HEADER } });
  check(status(a.dir, a.srv).level === 'off' && status(a.dir, a.srv).state === 'ready', 'a fresh Paper file reads as ready and Off');
  check(apply(a, 'basic') === 3, 'Basic writes the defaults, the Nether and the End');
  const n = readBlock(read(path.join(a.dir, NETHER26)));
  check(n.enabled === true && n['engine-mode'] === 1 && n['max-block-height'] === 128 && J(n['hidden-blocks']) === J(wanted('basic', 'nether')['hidden-blocks']), '26.x: the Nether\'s list is in world/dimensions/minecraft/the_nether');
  check(read(path.join(a.dir, NETHER26)).startsWith(WORLD_HEADER), 'its header and _version stay');
  check(J(readBlock(read(path.join(a.dir, END26)))) === '{"enabled":false}' && read(path.join(a.dir, END26)).startsWith('_version: 31\n'), 'the End gets enabled: false in a new file with the defaults\' _version');
  check(status(a.dir, a.srv).level === 'basic' && J(status(a.dir, a.srv).worlds) === J({ overworld: 'basic', nether: 'basic', end: 'off' }), `the status reads Basic back, dimension by dimension (${J(status(a.dir, a.srv).worlds)})`);
  const before = stateOf(a.dir);
  const mtime = statSync(defaultsOf(a)).mtimeMs;
  check(apply(a, 'basic') === 0 && J(stateOf(a.dir)) === J(before) && statSync(defaultsOf(a)).mtimeMs === mtime, 'applying the same level again writes nothing');
  check(apply(a, 'strong') === 2 && status(a.dir, a.srv).level === 'strong' && readBlock(read(path.join(a.dir, NETHER26)))['hidden-blocks'].includes('magma_block'), 'Strong changes the defaults and the Nether, and the End is already right');
  check(apply(a, 'layers') === 2 && status(a.dir, a.srv).level === 'layers', 'mode 3 on 26.3');
  check(apply(a, 'off') === 2 && status(a.dir, a.srv).level === 'off' && readBlock(read(path.join(a.dir, NETHER26))).enabled === false, 'Off turns the defaults and the Nether off');
  const hand = read(defaultsOf(a)).replace('    enabled: false\n', '    enabled: true\n');
  write(defaultsOf(a), hand);
  check(status(a.dir, a.srv).level === 'custom', 'a block changed by hand reads as Custom');
}
{
  const a = server({ mc: '1.21.1', files: { 'world_nether/paper-world.yml': WORLD_HEADER } });
  apply(a, 'strong');
  check(readBlock(read(path.join(a.dir, 'world_nether', 'paper-world.yml')))['max-block-height'] === 128 && readBlock(read(path.join(a.dir, 'world_the_end', 'paper-world.yml'))).enabled === false
    && !existsSync(path.join(a.dir, 'world', 'dimensions')), 'before 26: the Nether and the End are world_nether and world_the_end');
}
{
  const a = server({ props: 'level-name=mundo\n', files: { 'mundo/dimensions/minecraft/the_nether/paper-world.yml': WORLD_HEADER } });
  apply(a, 'basic');
  check(readBlock(read(path.join(a.dir, 'mundo/dimensions/minecraft/the_nether/paper-world.yml'))).enabled === true && !existsSync(path.join(a.dir, 'world')), 'level-name names the folder');
  const b = server({ mc: '1.21.1', props: 'level-name=mundo\n' });
  apply(b, 'basic');
  check(existsSync(path.join(b.dir, 'mundo_nether', 'paper-world.yml')) && existsSync(path.join(b.dir, 'mundo_the_end', 'paper-world.yml')), 'and the older folders follow it');
}
{
  const a = server({ props: 'allow-nether=false\n' });
  apply(a, 'basic');
  check(!existsSync(path.join(a.dir, NETHER26)) && existsSync(path.join(a.dir, END26)) && status(a.dir, a.srv).level === 'basic' && !('nether' in status(a.dir, a.srv).worlds), 'allow-nether=false makes no Nether file and the status leaves it out');
}
{
  const a = server({});
  apply(a, 'basic');
  const b = server({ files: { [NETHER26]: `${WORLD_HEADER}anticheat:\n  anti-xray:\n    enabled: true\n` } });
  check(status(b.dir, b.srv).level === 'custom', 'a Nether that turns itself on over Off defaults is not Off');
  check(apply(b, 'off') === 1 && readBlock(read(path.join(b.dir, NETHER26))).enabled === false && !existsSync(path.join(b.dir, END26)), 'and Off writes it, and makes no End file');
  const c = server({ files: { [NETHER26]: WORLD_HEADER } });
  check(apply(c, 'off') === 0 && read(path.join(c.dir, NETHER26)) === WORLD_HEADER, 'Off leaves a Nether that follows the defaults alone');
}
for (const [name, level] of [['..\\..\\escape', 'traversal with backslashes'], ['../../escape', 'traversal with slashes'], ['\\\\host\\share', 'a network path'], ['C:\\Windows', 'a drive path'], ['..', 'a parent folder']]) {
  const a = server({ props: `level-name=${name.replace(/\\/g, '\\\\')}\n` });
  const st = status(a.dir, a.srv);
  const p = planned(a.dir, a.srv, 'basic');
  check(st.state === 'refused' && st.code === 'badWorld' && p.refused?.code === 'badWorld', `refused: ${level} as the world name`);
}
{
  const a = server({ files: { 'world/dimensions/minecraft/overworld/paper-world.yml': `${WORLD_HEADER}anticheat:\n  anti-xray:\n    enabled: true\n` } });
  const before = stateOf(a.dir);
  const p = planned(a.dir, a.srv, 'basic');
  check(status(a.dir, a.srv).code === 'override' && p.refused?.code === 'override' && /overworld\/paper-world\.yml$/.test(p.refused.file) && J(stateOf(a.dir)) === J(before), 'an overworld override, which would beat the defaults, is refused and named');
  const b = server({ files: { 'world/dimensions/minecraft/overworld/paper-world.yml': WORLD_HEADER } });
  check(status(b.dir, b.srv).state === 'ready', 'an overworld paper-world.yml with no block is fine');
}
{
  const a = server({ config: `${HEAD}chunks:\n  a: 1\n` });
  const st = status(a.dir, a.srv);
  check(st.state === 'refused' && st.code === 'noBlock' && st.file === 'config/paper-world-defaults.yml', 'a defaults file with no block is refused and named');
  const b = server({ config: REAL, files: { [NETHER26]: 'anticheat: {}\n' } });
  check(status(b.dir, b.srv).code === 'shape' && /the_nether\/paper-world\.yml$/.test(status(b.dir, b.srv).file), 'a broken Nether file is refused and named');
  const c = server({ config: null });
  mkdirSync(path.join(c.dir, 'config'), { recursive: true });
  writeFileSync(defaultsOf(c), Buffer.concat([Buffer.from(REAL.slice(0, 40)), Buffer.from([0xff, 0xfe]), Buffer.from(REAL.slice(40))]));
  const raw = readFileSync(defaultsOf(c));
  const p = planned(c.dir, c.srv, 'basic');
  check(p.refused?.code === 'notText' && readFileSync(defaultsOf(c)).equals(raw), 'bytes that are not UTF-8 are refused rather than rewritten');
}

// ---------- each kind ----------
const others = [[{ plugins: false, mods: null, proxy: false, mc: '1.21.1' }, 'vanilla'], [{ plugins: false, mods: 'fabric-loader', proxy: false, mc: '1.21.1' }, 'modded'],
  [{ plugins: 'velocity', mods: null, proxy: true, mc: '3.4.0' }, 'proxy'], [{ ...PAPER21, mc: '1.18.2' }, 'tooOld']];
for (const [srv, state] of others) {
  const a = server({});
  const before = stateOf(a.dir);
  const r = assign(a.dir, srv, 'basic');
  check(status(a.dir, srv).state === state && r.outcome === 'skipped' && r.state === state && J(stateOf(a.dir)) === J(before), `${state}: no level, and "apply to my other servers" leaves it alone`);
}
{
  const a = server({ config: null });
  const st = status(a.dir, { ...a.srv, pending: 'basic' });
  check(st.state === 'notStarted' && st.pending === 'basic' && J(st.levels) === J(['off', 'basic', 'strong', 'layers']), 'no config yet: not started, with the level that waits');
  check(status(a.dir, { ...a.srv, pending: 'nonsense' }).pending === null && status(a.dir, { ...a.srv, pending: 'off' }).pending === null, 'a bad waiting value is ignored');
}

// ---------- backup ----------
{
  const a = server({ files: { [NETHER26]: WORLD_HEADER } });
  const original = read(defaultsOf(a));
  apply(a, 'basic');
  check(read(`${defaultsOf(a)}${BACKUP}`) === original, 'the first write leaves a backup of the file as it was');
  check(read(path.join(a.dir, `${NETHER26}${BACKUP}`)) === WORLD_HEADER, 'for the Nether file too');
  check(!existsSync(path.join(a.dir, `${END26}${BACKUP}`)), 'a file this app made has no backup');
  apply(a, 'strong');
  apply(a, 'off');
  check(read(`${defaultsOf(a)}${BACKUP}`) === original, 'later writes never replace it');
  const b = server({});
  check(apply(b, 'off') === 0 && !existsSync(`${defaultsOf(b)}${BACKUP}`), 'a write that changes nothing leaves no backup');
}

// ---------- atomic writes ----------
{
  const a = server({ files: { [NETHER26]: WORLD_HEADER } });
  const before = stateOf(a.dir);
  const realRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => { if (++renames === 2) throw Object.assign(new Error('locked'), { code: 'EISDIR' }); return realRename(from, to); };
  const realWrite = fs.writeFileSync;
  const inPlace = [];
  fs.writeFileSync = (file, ...rest) => { if (!String(file).endsWith('.nano-tmp')) inPlace.push(file); return realWrite(file, ...rest); };
  let failed = null;
  try { apply(a, 'basic'); } catch (err) { failed = err; } finally { fs.renameSync = realRename; fs.writeFileSync = realWrite; }
  check(!inPlace.length, `the way back writes no settings file in place: ${J(inPlace)}`);
  const after = stateOf(a.dir);
  const left = Object.keys(after).filter((f) => !f.endsWith(BACKUP));
  check(failed && renames === 3 && failed.refused.code === 'unwritable' && failed.refused.file === '', `a rename that fails partway stops the write, and the first file goes back by a rename of its own: ${renames} renames, ${J(failed?.refused)}`);
  check(left.every((f) => after[f] === before[f]) && left.length === Object.keys(before).length, 'every file is as it was, and no new file stays');
  check(!treeOf(a.dir).some((f) => f.endsWith('.nano-tmp')), 'and no temporary file stays');
  check(apply(a, 'basic') === 3 && status(a.dir, a.srv).level === 'basic', 'the next try goes through');
}
{
  const a = server({});
  const realRename = fs.renameSync;
  let tries = 0;
  fs.renameSync = (from, to) => { if (++tries <= 2) throw Object.assign(new Error('scanner'), { code: 'EPERM' }); return realRename(from, to); };
  let done = false;
  try { apply(a, 'off'); apply(a, 'basic'); done = true; } finally { fs.renameSync = realRename; }
  check(done && status(a.dir, a.srv).level === 'basic', 'a file a scanner holds for a moment is tried again');
  const b = server({});
  write(`${defaultsOf(b)}.nano-tmp`, 'half a file from a crash');
  check(apply(b, 'basic') > 0 && !existsSync(`${defaultsOf(b)}.nano-tmp`) && status(b.dir, b.srv).level === 'basic', 'a temporary file left by a crash is written over');
  const c = server({});
  write(`${defaultsOf(c)}.nano-tmp`, 'half a file from a crash');
  check(status(c.dir, c.srv).level === 'off' && read(defaultsOf(c)) === REAL, 'and is never read as the settings');
}

{
  const a = server({ files: { [NETHER26]: WORLD_HEADER } });
  const realRename = fs.renameSync;
  let renames = 0;
  // The second file will not go in, and the first will not go back.
  fs.renameSync = (from, to) => { if (++renames >= 2) throw Object.assign(new Error('locked'), { code: 'EISDIR' }); return realRename(from, to); };
  const plan = planned(a.dir, a.srv, 'basic');
  let got;
  try { got = commit(plan.changes); } finally { fs.renameSync = realRename; }
  const stuck = plan.changes[0].name;
  check(got?.code === 'partial' && got.file === stuck && /locked/.test(got.detail), `a file that will not go back is named: ${J(got)}`);
  check(!treeOf(a.dir).some((f) => f.endsWith('.nano-tmp')), 'and no temporary file stays');
  check(read(`${path.join(a.dir, stuck)}${BACKUP}`) === REAL, 'and its backup is there to compare with');
  const b = server({ files: { [NETHER26]: WORLD_HEADER } });
  mkdirSync(`${defaultsOf(b)}.nano-tmp`);
  const before = stateOf(b.dir);
  const refused = commit(planned(b.dir, b.srv, 'basic').changes);
  check(refused?.code === 'unwritable' && !refused.file, `a temporary file that cannot be written refuses the whole commit, with nothing to put back: ${J(refused)}`);
  check(J(stateOf(b.dir)) === J(before), 'and every file stays as it was');
  rmSync(`${defaultsOf(b)}.nano-tmp`, { recursive: true });
  const c = server({});
  mkdirSync(`${defaultsOf(c)}.nano-tmp`);
  const outcome = assign(c.dir, c.srv, 'basic');
  check(outcome.outcome === 'refused' && outcome.code === 'unwritable', `"apply to my other servers" reports it as a refusal: ${J(outcome)}`);
}

// ---------- apply to my other servers ----------
{
  const a = server({ files: { [NETHER26]: WORLD_HEADER } });
  check(J(assign(a.dir, a.srv, 'strong')) === J({ outcome: 'applied', pending: null }), 'a stopped server: applied');
  check(assign(a.dir, a.srv, 'strong').outcome === 'already', 'again: already at that level');
  const fresh = server({ config: null });
  check(J(assign(fresh.dir, fresh.srv, 'basic')) === J({ outcome: 'pending', pending: 'basic' }), 'a server that has not started: the level waits');
  check(J(assign(fresh.dir, fresh.srv, 'off')) === J({ outcome: 'cleared', pending: null }), 'Off clears what waits');
  check(!existsSync(path.join(fresh.dir, 'world')) && !existsSync(defaultsOf(fresh)), 'and neither writes a file the server has not made');
  const bad = server({ config: `${HEAD}chunks:\n  a: 1\n` });
  check(assign(bad.dir, bad.srv, 'basic').outcome === 'refused' && assign(bad.dir, bad.srv, 'basic').code === 'noBlock', 'a file of the wrong shape: refused, with the reason');
  const old = server({ mc: '1.20.4' });
  const before = stateOf(old.dir);
  const r = assign(old.dir, old.srv, 'layers');
  check(r.outcome === 'refused' && r.code === 'level' && J(stateOf(old.dir)) === J(before), 'mode 3 is refused on a version that may not load it, and the file stays');
  const oldFresh = server({ mc: '1.20.4', config: null });
  check(assign(oldFresh.dir, oldFresh.srv, 'layers').code === 'level', 'and is not left waiting on one either');
}

// ---------- a level that waits ----------
{
  const a = server({ config: null });
  const srv = { ...a.srv, pending: 'strong' };
  check(settle(a.dir, srv).outcome === 'waiting' && !settle(a.dir, srv).clear, 'before the first start it keeps waiting');
  write(defaultsOf(a), REAL);
  write(path.join(a.dir, NETHER26), WORLD_HEADER);
  const r = settle(a.dir, srv);
  check(r.outcome === 'applied' && r.clear && r.level === 'strong' && status(a.dir, a.srv).level === 'strong', 'once the file is there it goes in, with no step by the owner');
  check(settle(a.dir, a.srv).outcome === 'dropped', 'with nothing waiting there is nothing to do');
  const b = server({ config: `${HEAD}chunks:\n  a: 1\n` });
  const srvB = { ...b.srv, pending: 'basic' };
  const refused = settle(b.dir, srvB);
  check(refused.outcome === 'refused' && !refused.clear && refused.code === 'noBlock', 'a refused file keeps the level waiting and says why');
  write(defaultsOf(b), REAL);
  check(settle(b.dir, srvB).outcome === 'applied', 'and it goes in once the file is fixed');
  const c = server({});
  check(settle(c.dir, { plugins: false, mc: '1.21.1', pending: 'basic' }).clear === true && read(defaultsOf(c)) === REAL, 'a server that is no longer Paper drops the level and touches nothing');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAIL ${f.label}`);
process.exit(failed.length ? 1 : 0);
