// Java debugging: a JDWP client (the protocol of the JVM's own -agentlib:jdwp agent, so nothing is downloaded) that
// answers the DAP requests the debugger's renderer sends (renderer/features/debugger/index.js) and raises the DAP events
// it handles, so a JVM is debugged in the same Debug tool window as Python. debug.js connects it (debug:jvm).
//
// It follows IntelliJ IDEA's defaults: a breakpoint suspends every thread, stepping skips the JDK's classes (java.*,
// javax.*, jdk.*, sun.*, com.sun.*), and the Variables tree shows a collection's or map's elements, an array's items and
// an object's fields, an object by its class and id ({ArrayList@123}) with toString() where its class overrides it.
// Methods the debugger calls (toString(), size(), an evaluated call) run in the suspended thread only.
const fs = require('fs');
const path = require('path');
const jexpr = require('./debug-jvm-eval');

const { EvalError } = jexpr;

// ---------- the wire ----------
const HANDSHAKE = Buffer.from('JDWP-Handshake', 'ascii');
const REPLY = 0x80;
const CMD = {
  VM: 1, VM_CLASSES_BY_SIGNATURE: 2, VM_ALL_CLASSES: 3, VM_ALL_THREADS: 4, VM_DISPOSE: 6, VM_ID_SIZES: 7, VM_SUSPEND: 8,
  VM_RESUME: 9, VM_EXIT: 10, VM_CREATE_STRING: 11,
};
const SET = { VM: 1, REF: 2, CLASS: 3, IFACE: 5, METHOD: 6, OBJECT: 9, STRING: 10, THREAD: 11, ARRAY: 13, EVENT_REQUEST: 15, FRAME: 16, EVENT: 64 };
const EVENT = { SINGLE_STEP: 1, BREAKPOINT: 2, EXCEPTION: 4, THREAD_START: 6, THREAD_DEATH: 7, CLASS_PREPARE: 8, CLASS_UNLOAD: 9,
  METHOD_ENTRY: 40, METHOD_EXIT: 41, METHOD_EXIT_WITH_RETURN_VALUE: 42, VM_START: 90, VM_DEATH: 99 };
const SUSPEND = { NONE: 0, THREAD: 1, ALL: 2 };
const MOD = { COUNT: 1, CLASS_EXCLUDE: 6, LOCATION: 7, STEP: 10, SOURCE_NAME: 12 };
const STEP = { LINE: 1, INTO: 0, OVER: 1, OUT: 2 };
const INVOKE_SINGLE_THREADED = 1;
const ACC_STATIC = 0x0008;
const ERRORS = { 10: 'invalid thread', 13: 'thread not suspended', 20: 'object was collected', 21: 'invalid class', 23: 'invalid method',
  30: 'invalid frame', 32: 'opaque frame', 34: 'type mismatch', 35: 'invalid slot', 99: 'not implemented', 101: 'absent information',
  112: 'the VM is dead' };
const STEP_FILTERS = ['java.*', 'javax.*', 'jdk.*', 'sun.*', 'com.sun.*'];
const SIZE = { B: 1, Z: 1, C: 2, S: 2, I: 4, F: 4, J: 8, D: 8, V: 0 };

class JdwpError extends Error {
  constructor(code) {
    super(`JDWP error ${code}${ERRORS[code] ? ` (${ERRORS[code]})` : ''}`);
    this.code = code;
  }
}

class Writer {
  constructor(sizes) { this.sizes = sizes; this.parts = []; }
  raw(buf) { this.parts.push(buf); return this; }
  byte(v) { return this.raw(Buffer.from([v & 0xff])); }
  bool(v) { return this.byte(v ? 1 : 0); }
  int(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return this.raw(b); }
  long(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return this.raw(b); }
  id(v, size = this.sizes.objectIDSize) {
    const b = Buffer.alloc(size);
    let x = BigInt(v);
    for (let i = size - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return this.raw(b);
  }
  ref(v) { return this.id(v, this.sizes.referenceTypeIDSize); }
  method(v) { return this.id(v, this.sizes.methodIDSize); }
  field(v) { return this.id(v, this.sizes.fieldIDSize); }
  frame(v) { return this.id(v, this.sizes.frameIDSize); }
  str(s) { const b = Buffer.from(String(s), 'utf8'); this.int(b.length); return this.raw(b); }
  location(l) { return this.byte(l.tag).ref(l.cls).method(l.method).long(l.index); }
  untagged({ tag, v }) {
    switch (tag) {
      case 'Z': return this.bool(v);
      case 'B': return this.byte(v);
      case 'C': { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return this.raw(b); }
      case 'S': { const b = Buffer.alloc(2); b.writeInt16BE(v); return this.raw(b); }
      case 'I': return this.int(v);
      case 'J': return this.long(v);
      case 'F': { const b = Buffer.alloc(4); b.writeFloatBE(v); return this.raw(b); }
      case 'D': { const b = Buffer.alloc(8); b.writeDoubleBE(v); return this.raw(b); }
      case 'V': return this;
      default: return this.id(v || 0);
    }
  }
  tagged(v) { return this.byte(v.tag.charCodeAt(0)).untagged(v); }
  buffer() { return Buffer.concat(this.parts); }
}

class Reader {
  constructor(buf, sizes) { this.b = buf; this.o = 0; this.sizes = sizes; }
  byte() { return this.b.readUInt8(this.o++); }
  bool() { return this.byte() !== 0; }
  int() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  long() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  id(size = this.sizes.objectIDSize) {
    let x = 0n;
    for (let i = 0; i < size; i++) x = (x << 8n) | BigInt(this.b[this.o + i]);
    this.o += size;
    return Number(x);
  }
  ref() { return this.id(this.sizes.referenceTypeIDSize); }
  method() { return this.id(this.sizes.methodIDSize); }
  field() { return this.id(this.sizes.fieldIDSize); }
  frame() { return this.id(this.sizes.frameIDSize); }
  str() { const n = this.int(); const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  location() { return { tag: this.byte(), cls: this.ref(), method: this.method(), index: this.long() }; }
  untagged(tag) {
    switch (tag) {
      case 'Z': return { tag, v: this.bool() };
      case 'B': return { tag, v: this.b.readInt8(this.o++) };
      case 'C': { const v = this.b.readUInt16BE(this.o); this.o += 2; return { tag, v }; }
      case 'S': { const v = this.b.readInt16BE(this.o); this.o += 2; return { tag, v }; }
      case 'I': return { tag, v: this.int() };
      case 'J': return { tag, v: this.long() };
      case 'F': { const v = this.b.readFloatBE(this.o); this.o += 4; return { tag, v }; }
      case 'D': { const v = this.b.readDoubleBE(this.o); this.o += 8; return { tag, v }; }
      case 'V': return { tag, v: null };
      default: return { tag, v: this.id() };
    }
  }
  tagged() { return this.untagged(String.fromCharCode(this.byte())); }
}

// One JDWP connection: commands answered by id, and the composite events the VM sends.
class Jdwp {
  constructor(socket, onEvents) {
    this.socket = socket;
    this.onEvents = onEvents;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.sizes = { fieldIDSize: 8, methodIDSize: 8, objectIDSize: 8, referenceTypeIDSize: 8, frameIDSize: 8 };
    this.closed = false;
  }

  static handshake(socket, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let got = Buffer.alloc(0);
      const timer = setTimeout(() => done(new Error('The JVM did not answer the JDWP handshake')), timeoutMs);
      const onData = (d) => {
        got = Buffer.concat([got, d]);
        if (got.length < HANDSHAKE.length) return;
        if (!got.subarray(0, HANDSHAKE.length).equals(HANDSHAKE)) return done(new Error('Not a JDWP agent'));
        done(null, got.subarray(HANDSHAKE.length));
      };
      const onClose = () => done(new Error('The JVM closed the connection'));
      function done(err, rest) {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.off('error', onClose);
        if (err) reject(err); else resolve(rest);
      }
      socket.on('data', onData);
      socket.once('close', onClose);
      socket.once('error', onClose);
      socket.write(HANDSHAKE);
    });
  }

  attach(rest) {
    this.socket.on('data', (d) => this.receive(d));
    this.socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Debug session closed'));
      this.pending.clear();
    });
    if (rest?.length) this.receive(rest);
  }

  receive(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= 11) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < len) return;
      const packet = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      const id = packet.readUInt32BE(4);
      if (packet[8] & REPLY) {
        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);
        const code = packet.readUInt16BE(9);
        if (code) p.reject(new JdwpError(code)); else p.resolve(new Reader(packet.subarray(11), this.sizes));
      } else if (packet[9] === SET.EVENT && packet[10] === 100) {
        this.onEvents(new Reader(packet.subarray(11), this.sizes));
      }
    }
  }

  // body(w) writes the command's data. Resolves a Reader on the reply.
  command(set, cmd, body) {
    const w = new Writer(this.sizes);
    body?.(w);
    const data = w.buffer();
    const id = this.nextId++;
    const head = Buffer.alloc(11);
    head.writeUInt32BE(11 + data.length, 0);
    head.writeUInt32BE(id, 4);
    head[8] = 0;
    head[9] = set;
    head[10] = cmd;
    return new Promise((resolve, reject) => {
      if (this.closed || this.socket.destroyed) return reject(new Error('Debug session closed'));
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([head, data]));
    });
  }

  writer() { return new Writer(this.sizes); }
}

// ---------- names ----------
// 'Lorg/example/Main$Inner;' -> 'org.example.Main$Inner'; '[I' -> 'int[]'.
function typeName(sig) {
  let dims = 0;
  while (sig[dims] === '[') dims++;
  const base = sig.slice(dims);
  const name = base[0] === 'L' ? base.slice(1, -1).replace(/\//g, '.') : jexpr.TAG_NAMES[base[0]] || base;
  return name + '[]'.repeat(dims);
}
const simpleName = (sig) => typeName(sig).replace(/^.*\./, '');
const packageOf = (sig) => { const n = typeName(sig); const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(0, i); };
// The JDWP tag of a field, local or parameter by its signature.
const sigTag = (sig) => (sig[0] === '[' ? '[' : sig[0] === 'L' ? 'L' : sig[0]);
// '(ILjava/lang/String;[J)V' -> ['I', 'Ljava/lang/String;', '[J']
function paramSigs(sig) {
  const out = [];
  let i = 1;
  while (sig[i] !== ')') {
    const start = i;
    while (sig[i] === '[') i++;
    if (sig[i] === 'L') i = sig.indexOf(';', i);
    i++;
    out.push(sig.slice(start, i));
  }
  return out;
}

const BOXES = { 'Ljava/lang/Integer;': 'I', 'Ljava/lang/Long;': 'J', 'Ljava/lang/Short;': 'S', 'Ljava/lang/Byte;': 'B',
  'Ljava/lang/Character;': 'C', 'Ljava/lang/Boolean;': 'Z', 'Ljava/lang/Float;': 'F', 'Ljava/lang/Double;': 'D' };
const BOX_OF = Object.fromEntries(Object.entries(BOXES).map(([sig, tag]) => [tag, sig]));
const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
const MAX_TEXT = 10000;
const MAX_CHILDREN = 1000;
const TO_STRING_MS = 3000;

// The package a .java file declares, read from its text (comments skipped).
function declaredPackage(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  return /^\s*package\s+([\w.$]+)\s*;/m.exec(code)?.[1] ?? '';
}

// ---------- the session ----------
// opts: {onEvent(event, body), sourceRoots: folders to find a class's .java file in, log}.
class JvmSession {
  constructor(socket, { onEvent, sourceRoots = [], log }) {
    this.socket = socket;
    this.emit = onEvent;
    this.log = log;
    this.sourceRoots = sourceRoots;
    this.jdwp = new Jdwp(socket, (r) => this.onComposite(r));
    this.types = new Map(); // typeID -> {id, tag, sig, ...lazily: source, methods, fields, superclass, interfaces, lines, vars}
    this.files = new Map(); // path key -> {path, pkg, source, lines: [{line, condition, hitCondition, logMessage, hits}], requests: []}
    this.prepares = new Map(); // source file name -> ClassPrepare request id
    this.bpRequests = new Map(); // request id -> breakpoint line entry
    this.stopped = null; // {thread, reason}
    this.held = []; // event sets that suspended the VM while another stop is shown
    this.refs = new Map(); // variablesReference / frameId -> what it names, until the program resumes
    this.nextRef = 1;
    this.kept = []; // objects kept from collection while suspended (results of calls)
    this.gen = 0; // frame ids of a thread are fetched again after a method call ran in it
    this.invoking = null;
    this.stepRequest = null;
    this.events = Promise.resolve();
    this.calls = Promise.resolve(); // the method calls this side makes in the program, one after another
    this.started = new Promise((resolve) => { this.onStart = resolve; });
    this.paths = new Map(); // 'pkg/Source.java' -> path
  }

  async open() {
    const rest = await Jdwp.handshake(this.socket);
    this.jdwp.attach(rest);
    const r = await this.cmd(SET.VM, CMD.VM_ID_SIZES);
    this.jdwp.sizes = { fieldIDSize: r.int(), methodIDSize: r.int(), objectIDSize: r.int(), referenceTypeIDSize: r.int(), frameIDSize: r.int() };
  }

  cmd(set, c, body) { return this.jdwp.command(set, c, body); }

  // breakpoints: setBreakpoints arguments. suspended: the VM was started with suspend=y and waits for this side.
  async start(breakpoints, { suspended = false } = {}) {
    await this.open();
    for (const bp of breakpoints) await this.setBreakpoints(bp).catch((err) => this.log?.warn(`breakpoints: ${err.message}`));
    if (suspended) await Promise.race([this.started, new Promise((r) => setTimeout(r, 3000))]);
    await this.cmd(SET.VM, CMD.VM_RESUME);
  }

  // ---------- DAP ----------
  async request(command, args = {}) {
    const fn = this[`dap_${command}`];
    if (!fn) throw new Error(`${command} failed`);
    try {
      return await fn.call(this, args);
    } catch (err) {
      if (err instanceof EvalError || err instanceof JdwpError) throw new Error(err.message);
      throw err;
    }
  }

  async dap_threads() {
    const r = await this.cmd(SET.VM, CMD.VM_ALL_THREADS);
    const ids = Array.from({ length: r.int() }, () => r.id());
    const threads = [];
    for (const id of ids) {
      const name = await this.cmd(SET.THREAD, 1, (w) => w.id(id)).then((x) => x.str(), () => null);
      if (name != null) threads.push({ id, name });
    }
    return { threads };
  }

  async dap_stackTrace({ threadId, startFrame = 0, levels = 200 }) {
    if (!this.stopped) throw new Error('Not suspended');
    const r = await this.cmd(SET.THREAD, 6, (w) => w.id(threadId).int(0).int(-1));
    const frames = Array.from({ length: r.int() }, () => ({ id: r.frame(), loc: r.location() }));
    const stackFrames = [];
    for (const [i, f] of frames.entries()) {
      if (i < startFrame || stackFrames.length >= levels) continue;
      const t = await this.type(f.loc.cls, f.loc.tag);
      const m = (await this.methods(t)).find((x) => x.id === f.loc.method);
      const line = await this.lineOf(t, f.loc.method, f.loc.index);
      const source = await this.sourceOf(t);
      const ref = this.ref({ kind: 'frame', thread: threadId, index: i, id: f.id, gen: this.gen, loc: f.loc, type: t, method: m });
      stackFrames.push({ id: ref, name: `${simpleName(t.sig)}.${m?.name || '?'}`, line: line || 0, column: 1,
        source: source ? { name: source.name, ...(source.path ? { path: source.path } : {}) } : undefined });
    }
    return { stackFrames, totalFrames: frames.length };
  }

  async dap_scopes({ frameId }) {
    const frame = this.frameRef(frameId);
    return { scopes: [{ name: 'Locals', variablesReference: this.ref({ kind: 'locals', frame }), expensive: false }] };
  }

  async dap_variables({ variablesReference }) {
    const d = this.refs.get(variablesReference);
    if (!d || d.kind === 'frame') return { variables: [] };
    if (d.kind === 'locals') return { variables: await this.localVariables(d.frame) };
    return { variables: await this.children(d) };
  }

  async dap_evaluate({ expression, frameId }) {
    const frame = frameId ? this.frameRef(frameId) : null;
    if (!frame) throw new Error('Evaluation is available only while the program is suspended');
    const v = await this.eval(expression, frame);
    return this.describeResult(v, expression, frame);
  }

  async dap_setExpression({ expression, value, frameId }) {
    const frame = this.frameRef(frameId);
    const target = jexpr.parse(expression);
    if (!['name', 'field', 'index'].includes(target.t)) throw new Error('Cannot assign to this expression');
    const v = await jexpr.evaluate({ t: 'assign', target, value: jexpr.parse(value) }, this.context(frame));
    return this.describeResult(v, expression, frame);
  }

  async dap_setVariable({ variablesReference, name, value }) {
    const d = this.refs.get(variablesReference);
    if (!d) throw new Error('setVariable failed');
    const frame = d.frame || d;
    const v = await jexpr.run(value, this.context(frame));
    let set;
    if (d.kind === 'locals') set = this.context(frame).setLocal(name, v);
    else if (d.kind === 'object') set = this.context(frame).setField(d.value, name, v);
    else if (d.kind === 'array' && /^\[\d+\]$/.test(name)) set = this.context(frame).setElement(d.value, Number(name.slice(1, -1)), v);
    else throw new Error('setVariable failed');
    return this.describeResult(await set, null, frame);
  }

  async dap_continue() {
    await this.resume();
    return { allThreadsContinued: true };
  }

  dap_next({ threadId }) { return this.step(threadId, STEP.OVER); }
  dap_stepIn({ threadId }) { return this.step(threadId, STEP.INTO); }
  dap_stepOut({ threadId }) { return this.step(threadId, STEP.OUT); }

  // Pause suspends every thread and shows the main one (or the one asked for), as IntelliJ IDEA does.
  async dap_pause({ threadId }) {
    if (this.stopped) return {};
    await this.cmd(SET.VM, CMD.VM_SUSPEND);
    const { threads } = await this.dap_threads();
    const thread = threads.find((t) => t.id === threadId) || threads.find((t) => t.name === 'main') || threads[0];
    this.stopped = { thread: thread?.id, reason: 'pause' };
    this.emit('stopped', { reason: 'pause', threadId: thread?.id, allThreadsStopped: true });
    return {};
  }

  dap_setBreakpoints(args) { return this.setBreakpoints(args); }
  dap_setExceptionBreakpoints() { return {}; }

  // Stop ends a launched program; a JVM debugged by attaching keeps running (IntelliJ's Detach).
  async dap_disconnect({ terminateDebuggee }) {
    if (terminateDebuggee) await this.cmd(SET.VM, CMD.VM_EXIT, (w) => w.int(1)).catch(() => {});
    else await this.cmd(SET.VM, CMD.VM_DISPOSE).catch(() => {});
    this.socket.end();
    return {};
  }

  // ---------- events ----------
  onComposite(r) {
    const policy = r.byte();
    const events = [];
    const n = r.int();
    for (let i = 0; i < n; i++) {
      const kind = r.byte();
      const request = r.int();
      const e = { kind, request };
      if (kind === EVENT.VM_START || kind === EVENT.THREAD_START || kind === EVENT.THREAD_DEATH) e.thread = r.id();
      else if (kind === EVENT.SINGLE_STEP || kind === EVENT.BREAKPOINT || kind === EVENT.METHOD_ENTRY || kind === EVENT.METHOD_EXIT) {
        e.thread = r.id();
        e.loc = r.location();
      } else if (kind === EVENT.METHOD_EXIT_WITH_RETURN_VALUE) {
        e.thread = r.id(); e.loc = r.location(); e.value = r.tagged();
      } else if (kind === EVENT.EXCEPTION) {
        e.thread = r.id(); e.loc = r.location(); e.exception = r.tagged(); e.catchLoc = r.location();
      } else if (kind === EVENT.CLASS_PREPARE) {
        e.thread = r.id(); e.tag = r.byte(); e.type = r.ref(); e.sig = r.str(); e.status = r.int();
      } else if (kind === EVENT.CLASS_UNLOAD) e.sig = r.str();
      else if (kind !== EVENT.VM_DEATH) break; // an event this side never asked for: the rest cannot be read
      events.push(e);
    }
    // A class being prepared is handled at once, even while a stop is being handled: the thread that loads it may be
    // running a method this side called (toString()), which waits for it.
    const prepares = events.filter((e) => e.kind === EVENT.CLASS_PREPARE);
    if (prepares.length) {
      Promise.all(prepares.map((e) => this.classPrepared(e).catch((err) => this.log?.warn(`class prepare: ${err.message}`))))
        .then(() => (policy === SUSPEND.THREAD ? this.cmd(SET.THREAD, 3, (w) => w.id(prepares[0].thread)) : policy === SUSPEND.ALL ? this.cmd(SET.VM, CMD.VM_RESUME) : null))
        .catch(() => {});
    }
    if (events.some((e) => e.kind === EVENT.VM_START)) {
      this.onStart();
    }
    const stops = events.filter((e) => e.kind === EVENT.BREAKPOINT || e.kind === EVENT.SINGLE_STEP);
    // A breakpoint hit by a method this side calls (toString() for a value, a condition's call) is passed over at once:
    // the call waits for it.
    if (stops.length && this.invoking != null && stops.every((e) => e.thread === this.invoking)) this.resumeVm(policy);
    else if (stops.length) this.events = this.events.then(() => this.onStop(policy, stops)).catch((err) => this.log?.warn(`stop: ${err.message}`));
    if (events.some((e) => e.kind === EVENT.VM_DEATH)) {
      this.events = this.events.then(() => { this.stopped = null; this.emit('terminated', {}); });
    }
  }

  async onStop(policy, events, { held = false } = {}) {
    const thread = events[0].thread;
    if (this.stopped && !held) { this.held.push({ policy, events }); return; }
    const step = events.find((e) => e.kind === EVENT.SINGLE_STEP);
    if (!step) {
      let suspend = false;
      for (const e of events) {
        const bp = this.bpRequests.get(e.request);
        if (!bp) { suspend = true; continue; }
        if (await this.breakpointSuspends(bp, thread, e.loc)) suspend = true;
      }
      if (!suspend) return this.resumeVm(policy);
    }
    await this.clearStep();
    this.stopped = { thread, reason: step ? 'step' : 'breakpoint' };
    this.emit('stopped', { reason: this.stopped.reason, threadId: thread, allThreadsStopped: policy === SUSPEND.ALL });
  }

  resumeVm(policy) {
    return policy === SUSPEND.NONE ? null : this.cmd(SET.VM, CMD.VM_RESUME).catch(() => {});
  }

  // Hit counts as debugpy's (the renderer's breakpoint editor): "3" suspends on the 3rd hit, ">= 3" from the 3rd on,
  // "% 3" on every 3rd. A condition that cannot be evaluated suspends and says why. A log message prints its text
  // ({expression} parts evaluated) and goes on.
  async breakpointSuspends(bp, thread, loc) {
    bp.hits = (bp.hits || 0) + 1;
    const hc = String(bp.hitCondition || '').trim();
    if (hc) {
      const m = /^(>=|>|==|%)?\s*(\d+)$/.exec(hc);
      if (m) {
        const n = Number(m[2]);
        const ok = m[1] === '>=' ? bp.hits >= n : m[1] === '>' ? bp.hits > n : m[1] === '%' ? n > 0 && bp.hits % n === 0 : bp.hits === n;
        if (!ok) return false;
      }
    }
    const frame = { kind: 'frame', thread, index: 0, gen: -1, loc, atEvent: true };
    if (bp.condition) {
      try {
        const v = await this.eval(bp.condition, frame);
        const p = jexpr.isPrimitive(v) ? v : await this.unbox(v);
        if (p?.tag !== 'Z') throw new EvalError('Condition is not boolean');
        if (!p.v) return false;
      } catch (err) {
        this.emit('output', { category: 'stderr', output: `Breakpoint condition '${bp.condition}' could not be evaluated: ${err.message}\n`,
          condition: bp.condition, error: err.message });
        return true;
      }
    }
    if (bp.logMessage) {
      const text = await this.interpolate(bp.logMessage, frame);
      this.emit('output', { category: 'stdout', output: `${text}\n` });
      return false;
    }
    return true;
  }

  async interpolate(message, frame) {
    let out = '';
    for (const part of message.split(/(\{[^{}]*\})/)) {
      if (!/^\{[^{}]*\}$/.test(part)) { out += part; continue; }
      try { out += await this.text(await this.eval(part.slice(1, -1), frame), frame); } catch (err) { out += `<${err.message}>`; }
    }
    return out;
  }

  async resume() {
    if (!this.stopped) return;
    const { thread } = this.stopped;
    this.stopped = null;
    // A call that never returns (a toString() waiting for a lock another thread holds) does not hold the program.
    let timer;
    await Promise.race([this.calls, new Promise((r) => { timer = setTimeout(r, TO_STRING_MS); })]);
    clearTimeout(timer);
    await this.forget();
    await this.cmd(SET.VM, CMD.VM_RESUME);
    this.emit('continued', { threadId: thread, allThreadsContinued: true });
    const next = this.held.shift();
    if (next) this.events = this.events.then(() => this.onStop(next.policy, next.events, { held: true }));
  }

  async step(thread, depth) {
    if (!this.stopped) return {};
    await this.clearStep();
    const r = await this.cmd(SET.EVENT_REQUEST, 1, (w) => {
      w.byte(EVENT.SINGLE_STEP).byte(SUSPEND.ALL).int(2 + STEP_FILTERS.length);
      w.byte(MOD.STEP).id(thread).int(STEP.LINE).int(depth);
      for (const f of STEP_FILTERS) w.byte(MOD.CLASS_EXCLUDE).str(f);
      w.byte(MOD.COUNT).int(1);
    });
    this.stepRequest = r.int();
    await this.resume();
    return {};
  }

  async clearStep() {
    if (this.stepRequest == null) return;
    const id = this.stepRequest;
    this.stepRequest = null;
    await this.cmd(SET.EVENT_REQUEST, 2, (w) => w.byte(EVENT.SINGLE_STEP).int(id)).catch(() => {});
  }

  // What the views of a stop refer to ends with it.
  async forget() {
    this.refs.clear();
    const kept = this.kept.splice(0);
    for (const id of kept) this.cmd(SET.OBJECT, 8, (w) => w.id(id)).catch(() => {});
  }

  ref(d) { const id = this.nextRef++; this.refs.set(id, d); return id; }

  frameRef(id) {
    const d = this.refs.get(id);
    if (d?.kind !== 'frame') throw new Error('The frame is no longer available');
    return d;
  }

  // A frame's JDWP id, fetched again once a method call has run in its thread (the call ends the old ids).
  async frameId(frame) {
    if (frame.gen === this.gen && frame.id != null) return frame.id;
    const r = await this.cmd(SET.THREAD, 6, (w) => w.id(frame.thread).int(frame.index).int(1));
    if (!r.int()) throw new Error('The frame is no longer available');
    frame.id = r.frame();
    frame.loc = r.location();
    frame.gen = this.gen;
    return frame.id;
  }

  // ---------- breakpoints ----------
  // args: {source: {path}, breakpoints: [{line, condition?, hitCondition?, logMessage?}]}. Every class compiled from the
  // file gets them, nested and anonymous classes and lambdas included, also classes loaded later.
  async setBreakpoints({ source, breakpoints = [] }) {
    const file = source?.path;
    if (!file || !/\.java$/i.test(file)) return { breakpoints: breakpoints.map((b) => ({ verified: false, line: b.line })) };
    const key = file.toLowerCase();
    const old = this.files.get(key);
    for (const id of old?.requests || []) {
      this.bpRequests.delete(id);
      await this.cmd(SET.EVENT_REQUEST, 2, (w) => w.byte(EVENT.BREAKPOINT).int(id)).catch(() => {});
    }
    const pkg = old?.pkg ?? declaredPackage(file) ?? '';
    const name = path.basename(file);
    const entry = { path: file, pkg, source: name, lines: breakpoints.map((b) => ({ ...b, hits: 0, verified: false })), requests: [] };
    this.files.set(key, entry);
    this.paths.set(`${pkg.replace(/\./g, '/')}/${name}`.toLowerCase(), file);
    if (!entry.lines.length) return { breakpoints: [] };
    if (!this.prepares.has(name)) {
      const r = await this.cmd(SET.EVENT_REQUEST, 1, (w) => w.byte(EVENT.CLASS_PREPARE).byte(SUSPEND.THREAD).int(1).byte(MOD.SOURCE_NAME).str(name));
      this.prepares.set(name, r.int());
    }
    for (const t of await this.loadedTypesOf(entry)) await this.placeBreakpoints(entry, t);
    return { breakpoints: entry.lines.map((b) => ({ verified: b.verified, line: b.line })) };
  }

  // Loaded classes compiled from the file: in its package, with its source file name.
  async loadedTypesOf(entry) {
    const r = await this.cmd(SET.VM, CMD.VM_ALL_CLASSES);
    const prefix = entry.pkg ? `L${entry.pkg.replace(/\./g, '/')}/` : 'L';
    const found = [];
    const n = r.int();
    for (let i = 0; i < n; i++) {
      const tag = r.byte();
      const id = r.ref();
      const sig = r.str();
      r.int();
      if (!sig.startsWith(prefix) || sig.slice(prefix.length).includes('/')) continue;
      const t = this.knownType(id, tag, sig);
      if ((await this.sourceName(t)) === entry.source) found.push(t);
    }
    return found;
  }

  async classPrepared(e) {
    const t = this.knownType(e.type, e.tag, e.sig);
    const source = await this.sourceName(t);
    for (const entry of this.files.values()) {
      if (entry.source === source && entry.pkg === packageOf(e.sig) && entry.lines.length) await this.placeBreakpoints(entry, t);
    }
  }

  async placeBreakpoints(entry, t) {
    const methods = await this.methods(t);
    for (const bp of entry.lines) {
      for (const m of methods) {
        const table = await this.lineTable(t, m.id);
        const hits = table.filter((l) => l.line === bp.line);
        if (!hits.length) continue;
        const index = hits.reduce((a, b) => (a.index < b.index ? a : b)).index;
        const r = await this.cmd(SET.EVENT_REQUEST, 1, (w) => w.byte(EVENT.BREAKPOINT).byte(SUSPEND.ALL).int(1)
          .byte(MOD.LOCATION).location({ tag: t.tag, cls: t.id, method: m.id, index }));
        const id = r.int();
        entry.requests.push(id);
        this.bpRequests.set(id, bp);
        bp.verified = true;
      }
    }
  }

  // ---------- types ----------
  knownType(id, tag, sig) {
    let t = this.types.get(id);
    if (!t) { t = { id, tag, sig }; this.types.set(id, t); }
    if (sig) t.sig = sig;
    if (tag) t.tag = tag;
    return t;
  }

  async type(id, tag) {
    const t = this.knownType(id, tag);
    if (!t.sig) t.sig = await this.cmd(SET.REF, 1, (w) => w.ref(id)).then((r) => r.str());
    return t;
  }

  async typeOfObject(objectId) {
    const r = await this.cmd(SET.OBJECT, 1, (w) => w.id(objectId));
    const tag = r.byte();
    return this.type(r.ref(), tag);
  }

  sourceName(t) {
    t.source ??= this.cmd(SET.REF, 7, (w) => w.ref(t.id)).then((r) => r.str(), () => null);
    return t.source;
  }

  // The frame's .java file: one a breakpoint is set in, else <source root>/<package>/<file>, or <folder>/<file> for a
  // single source file run as `java File.java`.
  async sourceOf(t) {
    const name = await this.sourceName(t);
    if (!name) return null;
    const pkgPath = packageOf(t.sig).replace(/\./g, '/');
    const key = `${pkgPath}/${name}`.toLowerCase();
    if (!this.paths.has(key)) {
      const hit = this.sourceRoots.flatMap((root) => [path.join(root, pkgPath, name), path.join(root, name)])
        .find((p) => fs.existsSync(p) && declaredPackage(p) === packageOf(t.sig));
      this.paths.set(key, hit || null);
    }
    return { name, path: this.paths.get(key) };
  }

  methods(t) {
    t.methods ??= this.cmd(SET.REF, 5, (w) => w.ref(t.id)).then((r) => Array.from({ length: r.int() },
      () => ({ id: r.method(), name: r.str(), sig: r.str(), mods: r.int() })), () => []);
    return t.methods;
  }

  fields(t) {
    t.fields ??= this.cmd(SET.REF, 4, (w) => w.ref(t.id)).then((r) => Array.from({ length: r.int() },
      () => ({ id: r.field(), name: r.str(), sig: r.str(), mods: r.int(), owner: t })), () => []);
    return t.fields;
  }

  async superclass(t) {
    if (t.superclass === undefined) {
      const id = t.tag === 1 ? await this.cmd(SET.CLASS, 1, (w) => w.ref(t.id)).then((r) => r.ref(), () => 0) : 0;
      t.superclass = id ? await this.type(id, 1) : null;
    }
    return t.superclass;
  }

  async interfaces(t) {
    if (!t.interfaces) {
      const ids = await this.cmd(SET.REF, 10, (w) => w.ref(t.id)).then((r) => Array.from({ length: r.int() }, () => r.ref()), () => []);
      t.interfaces = [];
      for (const id of ids) t.interfaces.push(await this.type(id, 2));
    }
    return t.interfaces;
  }

  // The class, its superclasses, then every interface they implement.
  async hierarchy(t) {
    if (t.hierarchy) return t.hierarchy;
    const classes = [];
    for (let c = t; c; c = await this.superclass(c)) classes.push(c);
    const seen = new Set(classes.map((c) => c.id));
    const out = [...classes];
    for (let i = 0; i < out.length; i++) {
      for (const it of await this.interfaces(out[i])) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
    t.hierarchy = out;
    return out;
  }

  async isA(t, sig) { return (await this.hierarchy(t)).some((x) => x.sig === sig); }

  lineTable(t, methodId) {
    t.lines ??= new Map();
    if (!t.lines.has(methodId)) {
      t.lines.set(methodId, this.cmd(SET.METHOD, 1, (w) => w.ref(t.id).method(methodId)).then((r) => {
        r.long(); r.long();
        return Array.from({ length: r.int() }, () => ({ index: r.long(), line: r.int() }));
      }, () => []));
    }
    return t.lines.get(methodId);
  }

  async lineOf(t, methodId, index) {
    let best = null;
    for (const l of await this.lineTable(t, methodId)) if (l.index <= index && (!best || l.index >= best.index)) best = l;
    return best?.line ?? null;
  }

  variableTable(t, methodId) {
    t.vars ??= new Map();
    if (!t.vars.has(methodId)) {
      t.vars.set(methodId, this.cmd(SET.METHOD, 2, (w) => w.ref(t.id).method(methodId)).then((r) => {
        r.int();
        return Array.from({ length: r.int() }, () => ({ start: r.long(), name: r.str(), sig: r.str(), length: r.int(), slot: r.int() }));
      }, (err) => (err.code === 101 ? null : [])));
    }
    return t.vars.get(methodId);
  }

  // The frame's visible locals, parameters first (slot order), as javac -g records them.
  async frameLocals(frame) {
    const t = frame.type || await this.type(frame.loc.cls, frame.loc.tag);
    frame.type = t;
    const table = await this.variableTable(t, frame.loc.method);
    if (!table) return null;
    const at = frame.loc.index;
    const live = table.filter((v) => v.name !== 'this' && v.start <= at && at < v.start + BigInt(v.length));
    const byName = new Map();
    for (const v of live.sort((a, b) => a.slot - b.slot)) byName.set(v.name, v);
    return [...byName.values()];
  }

  async localValues(frame, vars) {
    if (!vars.length) return [];
    const fid = await this.frameId(frame);
    const r = await this.cmd(SET.FRAME, 1, (w) => {
      w.id(frame.thread).frame(fid).int(vars.length);
      for (const v of vars) w.int(v.slot).byte(sigTag(v.sig).charCodeAt(0));
    });
    return Array.from({ length: r.int() }, () => r.tagged());
  }

  async thisOf(frame) {
    if (frame.self !== undefined) return frame.self;
    const fid = await this.frameId(frame);
    const v = await this.cmd(SET.FRAME, 3, (w) => w.id(frame.thread).frame(fid)).then((r) => r.tagged(), () => null);
    frame.self = v?.v ? v : null;
    return frame.self;
  }

  async instanceFields(t) {
    const out = [];
    const chain = [];
    for (let c = t; c; c = await this.superclass(c)) chain.unshift(c);
    for (const c of chain) for (const f of await this.fields(c)) if (!(f.mods & ACC_STATIC)) out.push(f);
    return out;
  }

  async getFields(objectId, fields) {
    if (!fields.length) return [];
    const r = await this.cmd(SET.OBJECT, 2, (w) => { w.id(objectId).int(fields.length); for (const f of fields) w.field(f.id); });
    return Array.from({ length: r.int() }, () => r.tagged());
  }

  async findField(t, name, isStatic) {
    for (const c of await this.hierarchy(t)) {
      const f = (await this.fields(c)).find((x) => x.name === name && !!(x.mods & ACC_STATIC) === isStatic);
      if (f) return f;
    }
    return null;
  }

  async arrayLength(objectId) { return (await this.cmd(SET.ARRAY, 1, (w) => w.id(objectId))).int(); }

  async arrayValues(objectId, first, length) {
    if (!length) return [];
    const r = await this.cmd(SET.ARRAY, 2, (w) => w.id(objectId).int(first).int(length));
    const tag = String.fromCharCode(r.byte());
    const n = r.int();
    const primitive = tag in SIZE;
    return Array.from({ length: n }, () => (primitive ? r.untagged(tag) : r.tagged()));
  }

  async stringValue(objectId) { return (await this.cmd(SET.STRING, 1, (w) => w.id(objectId))).str(); }

  async createString(text) {
    const id = (await this.cmd(SET.VM, CMD.VM_CREATE_STRING, (w) => w.str(text))).id();
    this.keep(id);
    return { tag: 's', v: id };
  }

  keep(id) {
    if (!id) return;
    this.kept.push(id);
    this.cmd(SET.OBJECT, 7, (w) => w.id(id)).catch(() => {});
  }

  // Types by name: loaded classes only, as the program has them. 'Main', 'java.util.List', 'Outer$Inner'.
  async typeByName(name, frame) {
    const candidates = name.includes('.') ? [name] : [];
    if (!name.includes('.')) {
      const own = frame ? await this.type(frame.loc.cls, frame.loc.tag) : null;
      const pkg = own ? packageOf(own.sig) : '';
      if (own) candidates.push(`${typeName(own.sig)}$${name}`);
      candidates.push(pkg ? `${pkg}.${name}` : name, `java.lang.${name}`);
    }
    for (const c of candidates) {
      const sig = `L${c.replace(/\./g, '/')};`;
      const r = await this.cmd(SET.VM, CMD.VM_CLASSES_BY_SIGNATURE, (w) => w.str(sig));
      const n = r.int();
      if (!n) continue;
      const tag = r.byte();
      const id = r.ref();
      return { kind: 'type', name: c, t: this.knownType(id, tag, sig) };
    }
    return null;
  }

  // ---------- calls ----------
  // A method of the object's class (or a static one of the type) by name and arguments, the best match by the
  // arguments' types; primitives are boxed and strings made in the program where the parameters need it.
  async call(frame, target, name, args, isStatic) {
    const t = isStatic ? target.t : await this.typeOfObject(target.v);
    const candidates = [];
    for (const c of await this.hierarchy(t)) {
      for (const m of await this.methods(c)) {
        if (m.name !== name || !!(m.mods & ACC_STATIC) !== isStatic) continue;
        const params = paramSigs(m.sig);
        if (params.length !== args.length || candidates.some((x) => x.m.sig === m.sig)) continue;
        const score = await this.matchScore(params, args);
        if (score >= 0) candidates.push({ m, owner: c, params, score });
      }
    }
    if (!candidates.length) {
      throw Object.assign(new EvalError(`Cannot find method ${name}(${args.length ? '…' : ''}) in ${typeName(t.sig)}`), { notFound: true });
    }
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    const values = [];
    for (const [i, a] of args.entries()) values.push(await this.toParam(a, best.params[i], frame));
    return this.invoke(frame, isStatic ? null : target, best.owner, best.m, values);
  }

  async matchScore(params, args) {
    let score = 0;
    for (const [i, p] of params.entries()) {
      const a = args[i];
      if (p.length === 1) {
        const tag = jexpr.isPrimitive(a) ? a.tag : BOXES[(await this.sigOf(a))] || null;
        if (!tag) return -1;
        if (tag === p) score += 3;
        else if (p !== 'Z' && tag !== 'Z' && widens(tag, p)) score += 1;
        else return -1;
      } else if (jexpr.isPrimitive(a)) {
        if (p === BOX_OF[a.tag]) score += 2;
        else if (['Ljava/lang/Object;', 'Ljava/lang/Number;', 'Ljava/io/Serializable;', 'Ljava/lang/Comparable;'].includes(p)) score += 1;
        else return -1;
      } else if (a.tag === '$') {
        if (p === 'Ljava/lang/String;') score += 3;
        else if (['Ljava/lang/Object;', 'Ljava/lang/CharSequence;', 'Ljava/lang/Comparable;'].includes(p)) score += 1;
        else return -1;
      } else if (!a.v) score += 1;
      else {
        const sig = await this.sigOf(a);
        if (sig === p) score += 3;
        else if (p === 'Ljava/lang/Object;' || (p[0] === 'L' && sig[0] === 'L' && (await this.isA(await this.typeOfObject(a.v), p)))) score += 2;
        else if (p[0] === '[' && sig === p) score += 3;
        else return -1;
      }
    }
    return score;
  }

  async sigOf(v) {
    if (!v.v || jexpr.isPrimitive(v) || v.tag === '$') return null;
    return (await this.typeOfObject(v.v)).sig;
  }

  async toParam(a, p, frame) {
    if (p.length === 1) return jexpr.convert(jexpr.isPrimitive(a) ? a : await this.unbox(a), p);
    if (jexpr.isPrimitive(a)) return this.box(frame, a);
    if (a.tag === '$') return this.createString(a.text);
    return a;
  }

  // One call at a time (a thread runs one), and Resume and the steps wait for it (resume()): a breakpoint the
  // program hits once it runs again must not be taken for one the call hit.
  invoke(frame, self, owner, m, values) {
    const run = this.calls.then(() => this.invokeNow(frame, self, owner, m, values));
    this.calls = run.catch(() => {});
    return run;
  }

  async invokeNow(frame, self, owner, m, values) {
    // A frame of a breakpoint's condition or log message runs before the stop is shown.
    if (!this.stopped && !frame.atEvent) throw new EvalError('Not suspended');
    const thread = frame.thread;
    this.invoking = thread;
    this.gen++;
    let r;
    try {
      const body = (w) => {
        if (self) w.id(self.v).id(thread).ref(owner.id).method(m.id);
        else w.ref(owner.id).id(thread).method(m.id);
        w.int(values.length);
        for (const v of values) w.tagged(v);
        w.int(INVOKE_SINGLE_THREADED);
      };
      r = await (self ? this.cmd(SET.OBJECT, 6, body) : this.cmd(owner.tag === 2 ? SET.IFACE : SET.CLASS, owner.tag === 2 ? 1 : 3, body));
    } catch (err) {
      if (err.code === 13 || err.code === 10) throw new EvalError('Methods can be called only in a thread suspended by a breakpoint or a step');
      throw err;
    } finally {
      this.invoking = null;
    }
    const ret = r.tagged();
    const exc = r.tagged();
    if (exc.v) {
      this.keep(exc.v);
      const et = await this.typeOfObject(exc.v);
      throw new EvalError(`Method threw '${typeName(et.sig)}' exception.`);
    }
    if (ret.v && !jexpr.isPrimitive(ret)) this.keep(ret.v);
    return ret;
  }

  async findMethod(t, name, sig) {
    for (const c of await this.hierarchy(t)) {
      const m = (await this.methods(c)).find((x) => x.name === name && x.sig === sig && !(x.mods & ACC_STATIC));
      if (m) return { m, owner: c };
    }
    return null;
  }

  async callNoArgs(frame, obj, name, sig) {
    const found = await this.findMethod(await this.typeOfObject(obj.v), name, sig);
    if (!found) return null;
    return this.invoke(frame, obj, found.owner, found.m, []);
  }

  async unbox(v) {
    if (!v?.v || jexpr.isPrimitive(v) || v.tag === '$') return null;
    const t = await this.typeOfObject(v.v);
    if (!BOXES[t.sig]) return null;
    const f = await this.findField(t, 'value', false);
    return f ? (await this.getFields(v.v, [f]))[0] : null;
  }

  async box(frame, p) {
    const sig = BOX_OF[p.tag];
    const type = await this.typeByName(typeName(sig), null);
    if (!type) throw new EvalError(`${typeName(sig)} is not loaded`);
    const m = (await this.methods(type.t)).find((x) => x.name === 'valueOf' && x.sig === `(${p.tag})${sig}`);
    if (!m) throw new EvalError(`Cannot box a ${jexpr.TAG_NAMES[p.tag]}`);
    return this.invoke(frame, null, type.t, m, [p]);
  }

  // Java's String.valueOf: toString() on an object.
  async text(v, frame) {
    if (v.tag === '$') return v.text;
    if (jexpr.isPrimitive(v)) return jexpr.primitiveText(v);
    if (!v.v) return 'null';
    if (v.tag === 's') return this.stringValue(v.v);
    const s = await this.callNoArgs(frame, v, 'toString', '()Ljava/lang/String;');
    return s?.v ? this.stringValue(s.v) : 'null';
  }

  // ---------- evaluation ----------
  async eval(expression, frame) {
    return jexpr.run(expression, this.context(frame));
  }

  context(frame) {
    const s = this;
    const locals = async () => (await s.frameLocals(frame)) || [];
    const fieldOf = async (obj, name) => {
      if (obj.tag === '[') return null;
      const f = await s.findField(await s.typeOfObject(obj.v), name, false);
      return f ? { f, v: (await s.getFields(obj.v, [f]))[0] } : null;
    };
    // A value as a field, local or element of signature sig holds it.
    const toType = async (v, sig) => {
      if (sig.length === 1) {
        const p = jexpr.isPrimitive(v) ? v : await s.unbox(v);
        if (!p) throw new EvalError(`Incompatible types: cannot be converted to ${typeName(sig)}`);
        return jexpr.convert(p, sig);
      }
      if (jexpr.isPrimitive(v)) return s.box(frame, v);
      if (v.tag === '$') return s.createString(v.text);
      return v;
    };
    const frameType = async () => {
      const t = await s.type(frame.loc.cls, frame.loc.tag);
      return { kind: 'type', name: typeName(t.sig), t };
    };
    return {
      local: async (name) => {
        const v = (await locals()).find((x) => x.name === name);
        return v ? (await s.localValues(frame, [v]))[0] : undefined;
      },
      setLocal: async (name, value) => {
        const v = (await locals()).find((x) => x.name === name);
        if (!v) throw new EvalError(`Cannot find symbol ${name}`);
        const typed = await toType(value, v.sig);
        const fid = await s.frameId(frame);
        await s.cmd(SET.FRAME, 2, (w) => w.id(frame.thread).frame(fid).int(1).int(v.slot).tagged(typed));
        return typed;
      },
      thisObject: () => s.thisOf(frame),
      field: async (obj, name) => (await fieldOf(obj, name))?.v,
      setField: async (obj, name, value) => {
        const found = await fieldOf(obj, name);
        if (!found) throw new EvalError(`Cannot find symbol ${name}`);
        const typed = await toType(value, found.f.sig);
        await s.cmd(SET.OBJECT, 3, (w) => w.id(obj.v).int(1).field(found.f.id).untagged(typed));
        return typed;
      },
      staticField: async (type, name) => {
        const t = type.t || type;
        const f = await s.findField(t, name, true);
        if (!f) return undefined;
        const r = await s.cmd(SET.REF, 6, (w) => w.ref(f.owner.id).int(1).field(f.id));
        r.int();
        return r.tagged();
      },
      setStaticField: async (type, name, value) => {
        const t = type.t || type;
        const f = await s.findField(t, name, true);
        if (!f) throw new EvalError(`Cannot find symbol ${name}`);
        const typed = await toType(value, f.sig);
        await s.cmd(SET.CLASS, 2, (w) => w.ref(f.owner.id).int(1).field(f.id).untagged(typed));
        return typed;
      },
      type: (name) => s.typeByName(name, frame),
      frameType,
      // orStatic: an unqualified call, an instance method of this or else a static one of the frame's class.
      call: async (target, name, args, isStatic, orStatic = false) => {
        try {
          return await s.call(frame, target, name, args, isStatic);
        } catch (err) {
          if (!orStatic || !err.notFound) throw err;
          return s.call(frame, await frameType(), name, args, true);
        }
      },
      arrayLength: (arr) => s.arrayLength(arr.v),
      element: async (arr, i) => (await s.arrayValues(arr.v, i, 1))[0],
      setElement: async (arr, i, value) => {
        const t = await s.typeOfObject(arr.v);
        const typed = await toType(value, t.sig.slice(1));
        await s.cmd(SET.ARRAY, 3, (w) => w.id(arr.v).int(i).int(1).untagged(typed));
        return typed;
      },
      unbox: (v) => s.unbox(v),
      text: (v) => s.text(v, frame),
    };
  }

  // ---------- the Variables tree ----------
  async localVariables(frame) {
    const vars = await this.frameLocals(frame);
    const out = [];
    const self = await this.thisOf(frame);
    if (self) out.push(await this.variable('this', self, 'this', frame));
    if (!vars) {
      out.push({ name: 'Variables debug info not available', value: '', variablesReference: 0, presentationHint: { kind: 'virtual' } });
      return out;
    }
    const values = await this.localValues(frame, vars);
    for (const [i, v] of vars.entries()) out.push(await this.variable(v.name, values[i], v.name, frame));
    return out;
  }

  async children(d) {
    const { frame } = d;
    const sub = (expr) => (d.expr ? expr : null);
    if (d.kind === 'array') {
      const len = await this.arrayLength(d.value.v);
      const n = Math.min(len, MAX_CHILDREN);
      const values = await this.arrayValues(d.value.v, 0, n);
      const out = [];
      for (const [i, v] of values.entries()) out.push(await this.variable(`[${i}]`, v, sub(`${d.expr}[${i}]`), frame));
      if (len > n) out.push({ name: '…', value: `${len - n} more`, variablesReference: 0 });
      return out;
    }
    if (d.kind === 'collection') {
      const arr = await this.callNoArgs(frame, d.value, 'toArray', '()[Ljava/lang/Object;');
      if (!arr?.v) return [];
      const len = await this.arrayLength(arr.v);
      const n = Math.min(len, MAX_CHILDREN);
      const out = [];
      for (const [i, v] of (await this.arrayValues(arr.v, 0, n)).entries()) {
        out.push(await this.variable(`[${i}]`, v, d.list ? sub(`${d.expr}.get(${i})`) : null, frame));
      }
      if (len > n) out.push({ name: '…', value: `${len - n} more`, variablesReference: 0 });
      return out;
    }
    if (d.kind === 'map') {
      const set = await this.callNoArgs(frame, d.value, 'entrySet', '()Ljava/util/Set;');
      const arr = set?.v ? await this.callNoArgs(frame, set, 'toArray', '()[Ljava/lang/Object;') : null;
      if (!arr?.v) return [];
      const n = Math.min(await this.arrayLength(arr.v), MAX_CHILDREN);
      const out = [];
      for (const entry of await this.arrayValues(arr.v, 0, n)) {
        const k = await this.callNoArgs(frame, entry, 'getKey', '()Ljava/lang/Object;');
        const v = await this.callNoArgs(frame, entry, 'getValue', '()Ljava/lang/Object;');
        const key = k ? await this.describe(k, frame) : { value: '?' };
        const literal = k && (k.tag === 's' || (await this.unbox(k))) ? key.value : null;
        out.push(await this.variable(key.value, v || { tag: 'L', v: 0 }, literal != null ? sub(`${d.expr}.get(${literal})`) : null, frame));
      }
      return out;
    }
    const t = await this.typeOfObject(d.value.v);
    const fields = await this.instanceFields(t);
    const values = await this.getFields(d.value.v, fields);
    const out = [];
    for (const [i, f] of fields.entries()) out.push(await this.variable(f.name, values[i], sub(`${d.expr}.${f.name}`), frame));
    return out;
  }

  async variable(name, value, evaluateName, frame) {
    const r = await this.describe(value, frame, evaluateName);
    return { name, value: r.value, type: r.type, variablesReference: r.ref, ...(evaluateName ? { evaluateName } : {}) };
  }

  async describeResult(v, expression, frame) {
    if (v.tag === '$') return { result: quote(v.text), type: 'String', variablesReference: 0 };
    const r = await this.describe(v, frame, expression);
    return { result: r.value, type: r.type, variablesReference: r.ref };
  }

  // -> {value, type, ref}: how IntelliJ IDEA shows a value. ref > 0 when it can be expanded.
  async describe(v, frame, expr = null) {
    if (jexpr.isPrimitive(v)) {
      const value = v.tag === 'C' ? `'${String.fromCharCode(v.v)}' ${v.v}` : jexpr.primitiveText(v);
      return { value, type: jexpr.TAG_NAMES[v.tag], ref: 0 };
    }
    if (v.tag === 'V') return { value: 'void', type: '', ref: 0 };
    if (!v.v) return { value: 'null', type: '', ref: 0 };
    if (v.tag === 's') {
      const text = await this.stringValue(v.v);
      return { value: quote(text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text), type: 'String', ref: 0 };
    }
    const t = await this.typeOfObject(v.v);
    const id = `${simpleName(t.sig)}@${v.v}`;
    const node = (kind, extra = {}) => this.ref({ kind, value: v, expr, frame, ...extra });
    if (t.sig[0] === '[') {
      const len = await this.arrayLength(v.v);
      const label = `${simpleName(t.sig).replace(/\[\]/, `[${len}]`)}@${v.v}`;
      let preview = '';
      if (t.sig.length === 2) {
        const items = await this.arrayValues(v.v, 0, Math.min(len, 20));
        preview = `[${items.map((x) => (x.tag === 'C' ? `'${String.fromCharCode(x.v)}'` : jexpr.primitiveText(x))).join(', ')}${len > 20 ? ', …' : ''}]`;
      }
      return { value: preview, type: label, ref: len ? node('array') : 0 };
    }
    const boxed = BOXES[t.sig];
    if (boxed) {
      const p = await this.unbox(v);
      return { value: p ? (p.tag === 'C' ? `'${String.fromCharCode(p.v)}'` : jexpr.primitiveText(p)) : '', type: id, ref: node('object') };
    }
    if (await this.isA(t, 'Ljava/util/Map;')) {
      const size = await this.safeCall(frame, v, 'size', '()I');
      return { value: size ? `size = ${size.v}` : '', type: id, ref: node('map') };
    }
    if (await this.isA(t, 'Ljava/util/Collection;')) {
      const size = await this.safeCall(frame, v, 'size', '()I');
      return { value: size ? `size = ${size.v}` : '', type: id, ref: node('collection', { list: await this.isA(t, 'Ljava/util/List;') }) };
    }
    const fields = await this.instanceFields(t);
    let value = '';
    if (await this.overridesToString(t)) {
      const s = await this.safeCall(frame, v, 'toString', '()Ljava/lang/String;');
      if (s?.v) {
        const text = await this.stringValue(s.v);
        value = (await this.isA(t, 'Ljava/lang/Enum;')) ? text : quote(text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
      }
    }
    return { value, type: id, ref: fields.length ? node('object') : 0 };
  }

  // A call made to show a value: in a frame that can run it, with a time limit, and with no error shown.
  async safeCall(frame, obj, name, sig) {
    if (!frame || this.stopped?.reason === 'pause') return null;
    let timer;
    try {
      return await Promise.race([this.callNoArgs(frame, obj, name, sig).catch(() => null),
        new Promise((r) => { timer = setTimeout(() => r(null), TO_STRING_MS); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async overridesToString(t) {
    for (const c of await this.hierarchy(t)) {
      if ((await this.methods(c)).some((m) => m.name === 'toString' && m.sig === '()Ljava/lang/String;')) return c.sig !== 'Ljava/lang/Object;';
    }
    return false;
  }
}

// Java's widening primitive conversions.
const WIDER = { B: 'SIJFD', S: 'IJFD', C: 'IJFD', I: 'JFD', J: 'FD', F: 'D', D: '' };
const widens = (from, to) => (WIDER[from] || '').includes(to);

module.exports = { JvmSession };
module.exports.register = () => {};
