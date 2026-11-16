// ui-meters.js run as it is, in a page made of stubs: its panel mounted, each animation frame called with the time and
// the engine's levels a Rust test sends, and the meters' state read after each, so the ballistics (rise at once, fall
// 30 dB a second, the peak hold for 1.5 s then 20 dB a second, the clip light, the readout) are compared as the panel
// computes them. A level of null is -Infinity (silence).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');

function node() {
  const classes = new Set();
  const n = {
    children: [], style: {}, dataset: {}, hidden: false, textContent: '', isConnected: true, clientWidth: 40, clientHeight: 200,
    width: 0, height: 0, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    append: (...k) => { for (const c of k) if (c && typeof c === "object") c.parentNode = n; n.children.push(...k); }, appendChild: (k) => { k.parentNode = n; n.children.push(k); return k; }, remove() {}, replaceChildren: () => { n.children = []; },
    querySelector: () => node(), setAttribute() {},
    addEventListener: (type, fn) => { (n.listeners[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 200 }),
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
  };
  return n;
}

function mount() {
  let raf = null;
  const levels = { playing: false, m: null };
  const panels = {};
  const Cut = {
    ui: {
      el: (tag, cls, text) => { const n = node(); n.tag = tag; n.cls = cls; if (text !== undefined) n.textContent = text; return n; },
      registerPanel: (id, p) => { panels[id] = p; },
      monitors: { program: { player: { audio: { meters: () => levels.m } } } },
    },
  };
  const sandbox = {
    Cut, globalThis: null, tr: (s) => s, devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { raf = fn; return 1; }, cancelAnimationFrame: () => { raf = null; },
    document: { documentElement: {} },
    ide: { util: { observeSize: () => ({ disconnect() {} }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(CUT, 'ui-meters.js'), 'utf8'), sandbox);
  const listeners = {};
  const app = { get playing() { return levels.playing; }, on: (ev, fn) => { listeners[ev] = fn; return () => {}; } };
  const host = node();
  panels.meters.mount(host, app);
  return { Cut, levels, listeners, take: () => { const f = raf; raf = null; return f; }, host };
}

const db = (v) => (v === null || v === undefined ? -Infinity : v);

// steps: [{ now, playing, peak: [l, r], rms: [l, r] } | { wake: true } | { reset: true }]. A frame step runs the
// frame the panel asked for, or none when it asked for none (`ran: false`). -> after each step: the state, the
// readouts, whether each clip light is on, and whether the panel asks for another frame.
function run(steps) {
  const p = mount();
  const out = [];
  let next = p.take();
  for (const s of steps) {
    if (s.reset) p.Cut.ui.meters.reset();
    else if (s.wake) { p.levels.playing = !!s.playing; p.listeners.playing?.(); next = next || p.take(); }
    else {
      p.levels.playing = !!s.playing;
      p.levels.m = s.peak ? { masterChannels: s.peak.map(db), masterRms: (s.rms || [null, null]).map(db) } : null;
      const f = next;
      next = null;
      if (f) f(s.now);
      next = p.take();
      s.ran = !!f;
    }
    const box = p.host.children[0];
    const clips = box.children[0].children;
    const readout = box.children[2].children;
    out.push({ ran: s.ran ?? null, state: p.Cut.ui.meters.state, read: readout.map((r) => r.textContent), lights: clips.map((b) => b.classList.contains('on')), asks: !!next });
  }
  return out;
}

// ui-mixer.js mounted the same way on a sequence with one audio track A1: its fader scale (`posOf` of `dbs`, `dbOf`
// of `positions`) and, for each step as `run` takes them (the levels are A1's and the master's), the strips' peaks.
function mixer(dbs, positions, steps) {
  let raf = null;
  const levels = { playing: false, m: null };
  const panels = {};
  const button = () => { const n = node(); n.setPressed = () => {}; return n; };
  const Cut = {
    commands: {},
    ui: {
      el: (tag, cls, text) => { const n = node(); if (text !== undefined) n.textContent = text; n.querySelector = () => node(); n.setAttribute = () => {}; return n; },
      button, registerPanel: (id, p) => { panels[id] = p; }, workspaces: [],
      monitors: { program: { player: { audio: { meters: () => levels.m } } } },
    },
  };
  const sandbox = {
    Cut, tr: (s) => s, devicePixelRatio: 1, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { raf = fn; return 1; }, cancelAnimationFrame: () => { raf = null; },
    document: { documentElement: {} }, ide: { util: { observeSize: () => ({ disconnect() {} }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(CUT, 'ui-mixer.js'), 'utf8'), sandbox);
  const listeners = {};
  const app = {
    get playing() { return levels.playing; }, on: (ev, fn) => { listeners[ev] = fn; return () => {}; },
    sequence: { id: 's1', masterGain: 0, tracks: [{ id: 'A1', kind: 'audio', name: 'A1', volume: 0, pan: 0 }] },
  };
  panels.mixer.mount(node(), app);
  const M = Cut.ui.mixer;
  const out = [];
  let next = null;
  for (const s of steps) {
    if (s.reset) { out.push(null); continue; }
    if (s.wake) { levels.playing = !!s.playing; listeners.playing?.(); next = next || raf; raf = null; out.push(null); continue; }
    levels.playing = !!s.playing;
    levels.m = s.peak ? { masterChannels: s.peak.map(db), trackChannels: { A1: (s.track || s.peak).map(db) } } : null;
    const f = next;
    next = null;
    if (f) f(s.now);
    next = raf;
    raf = null;
    out.push({ ran: !!f, strips: M.strips.map((x) => ({ id: x.id, peak: x.peak })) });
  }
  return { pos: dbs.map((d) => M.posOf(d === null ? -Infinity : d)), db: positions.map((p) => M.dbOf(p)), steps: out };
}

module.exports = { run, mixer };
