// One running server: sits on the process's output as startProcess's filter, keeps who is on, records events, and asks
// the server things through its console. Commands and their answers share a stream with everything players type, so an
// answer counts only while its query is in flight, only on the server thread, and only when it is not shaped like
// something a player typed. A data answer can run over many lines that a player wrote (see snbtEnd): until it ends, the
// stream is that answer, whatever its lines look like. A session starts with the process and ends at its exit; nothing
// outlives that.
const { split, plain, classify, typed, namesIn } = require('./logparse');
const { parseSnbt, snbtEnd, posOf } = require('./nbt');
const { offlineUuid } = require('../server-settings');

// A query's match() returns this for an answer's line when more lines are to come.
const MORE = Symbol('more');
// And this for the first line of SNBT, which ends where snbtEnd says it does. The query gets the whole text.
class Snbt { constructor(text) { this.text = text; } }
const LINE_MAX = 4 << 20;
// What of a data answer is kept, and how long it may run. The game prints it in one write, so ten seconds is a stall: the
// lines count as lines again rather than the server going deaf. Past the kept part the answer is still read to its end,
// because one book holds more lines than a cap could allow and the lines after a cap are what a forger would aim at.
const ANSWER_SIZE = 16 << 20;
const ANSWER_LINES = 100000;
const ANSWER_MS = 10000;
const QUEUE_MAX = 32;
// How long, and how many, queries that timed out still wait for their answer.
const LATE_MS = 10000;
const LATE_MAX = 8;
const WATCH_MS = 30000;
const failure = (message, code) => Object.assign(new Error(message), { expected: true, code });

const NOT_FOUND = /^(?:No entity was found|No player was found|Found no elements matching |Unknown (?:or incomplete )?command)/;
// The SNBT that `data get entity <name> [path]` prints for that player, or null when the server says there is none.
const matchData = (name) => {
  const head = `${name} has the following entity data: `;
  return (msg) => {
    if (msg.startsWith(head)) return new Snbt(msg.slice(head.length));
    return NOT_FOUND.test(msg) ? null : undefined;
  };
};
// A `data get` nobody here asked, typed into the console by the owner. A lectern's book prints the same way.
// An entity that is no player prints its type or custom name (group 1), which can be any text.
const DATA_ANSWER = /^(?:(.{1,256}?) has the following entity data|-?\d+, -?\d+, -?\d+ has the following block data|Storage \S+ has the following contents): /;

// `list uuids` prints each player's own name and id (commands.list.nameAndId, getName() in ListPlayersCommand of 1.20.1 and
// 26.3); plain `list` prints display names, which a team's prefix makes into other names. -> [{name, uuid}], or null when
// an entry is not that pair. The answer is one line from 1.13, two before it (and with Bukkit's own list, whose second
// line starts with a group).
const ENTRY = /^([A-Za-z0-9_.]{1,16}) \(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)$/;
const playersOf = (text, count) => {
  const entries = text.replace(/^[^:,(]*: /, '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => ENTRY.exec(s));
  if (entries.length !== count || !entries.every(Boolean)) return null;
  return entries.map((m) => ({ name: m[1], uuid: m[2].toLowerCase() }));
};
function matchList() {
  let expected = null; // how many players the second line has to hold; any other line is not that line
  return (msg) => {
    if (expected !== null) return playersOf(msg, expected) ?? undefined;
    let m = /^There are (\d+) of a max of \d+ players online:(?: (.*))?$/.exec(msg);
    if (m) return playersOf(m[2] ?? '', Number(m[1]));
    m = /^There are (\d+)(?:\/| out of maximum )\d+ players online[:.]$/.exec(msg);
    if (!m) return undefined;
    if (m[1] === '0') return [];
    expected = Number(m[1]);
    return MORE;
  };
}

// `data` came with 1.13. Newer versions (26.x) have another numbering.
const hasDataCommand = (version) => { const m = /^1\.(\d+)/.exec(version || ''); return !m || Number(m[1]) >= 13; };

function createSession({ version, proxy = false, store, notify = () => {}, log = () => {}, onEnd = () => {}, pollMs = 1000, listMs = 60000, pingMs = 250, now = Date.now }) {
  let state = 'starting';
  let proc = null;
  const online = new Map(); // name -> {name, uuid, since, pos}
  const uuids = new Map(); // name -> uuid, from the server's own lines
  let usercache = new Map();
  let current = null; // the query in flight
  // Queries that timed out, oldest first. The server answers in order, so a late answer is theirs before the current one's.
  const late = [];
  let open = null; // a data answer not yet at its end: {q, shown, scan, parts, size, until}
  const queue = [];
  let poller = null;
  let polling = false;
  let nextList = 0;
  let turn = 0;
  let watchUntil = 0;
  const pings = new Map(); // kind -> timer

  // Coalesced: chat in a busy server would otherwise be one window message per line.
  const ping = (kind) => {
    if (pings.has(kind)) return;
    const timer = setTimeout(() => { pings.delete(kind); notify(kind); }, pingMs);
    timer.unref?.();
    pings.set(kind, timer);
  };

  // ---------- players ----------
  const uuidOf = (name) => uuids.get(name) ?? store.uuidOf(name) ?? usercache.get(name) ?? offlineUuid(name);
  function joined(name, { ip, x, y, z, why }) {
    if (online.has(name)) return;
    const uuid = uuidOf(name);
    online.set(name, { name, uuid, since: now(), pos: x === undefined ? null : { x, y, z, dimension: null } });
    store.touch(uuid, name);
    store.add({ type: 'join', name, uuid, text: '', ...(ip && { ip }), ...(x !== undefined && { x, y, z }), ...(why && { why }) });
    ping('roster');
    ping('event');
  }
  function left(name, text, why) {
    const p = online.get(name);
    if (!p) return;
    online.delete(name);
    store.touch(p.uuid, name, { playTimeMs: Math.max(0, now() - p.since) });
    store.add({ type: 'leave', name, uuid: p.uuid, text, ...(why && { why }) });
    ping('roster');
    ping('event');
  }
  // Join and leave lines can be missing (a plugin that replaces them, a line lost at a crash): `list uuids` has the last word.
  function reconcile(listed, asked) {
    const ids = new Set(listed.map((p) => p.uuid));
    for (const p of [...online.values()]) if (!ids.has(p.uuid) && p.since < asked) left(p.name, '', 'reconciled');
    for (const { name, uuid } of listed) {
      uuids.set(name, uuid);
      if (!online.has(name)) joined(name, { why: 'reconciled' });
    }
  }

  // ---------- queries ----------
  function failAll(code) {
    const all = current ? [current, ...queue] : [...queue];
    current = null;
    queue.length = 0;
    late.length = 0;
    for (const q of all) {
      clearTimeout(q.timer);
      q.reject(failure('The server stopped', code));
    }
  }
  // A query that timed out can still be the one an open answer belongs to: settling it twice changes nothing.
  function settle(q, how, value) {
    clearTimeout(q.timer);
    if (current === q) current = null;
    q[how](value);
    pump();
  }
  function pump() {
    if (current || !queue.length) return;
    const q = queue.shift();
    current = q;
    q.timer = setTimeout(() => {
      // One whose answer a late answer may have taken is owed none: waiting for it would pass the mistake on.
      if (!q.robbed && open?.q !== q) {
        late.push(Object.assign(q, { until: now() + LATE_MS }));
        if (late.length > LATE_MAX) late.shift();
      }
      settle(q, 'reject', failure(`The server did not answer ${q.command}`, 'timeout'));
    }, q.timeoutMs);
    q.timer.unref?.();
    try { proc.stdin.write(`${q.command}\n`); } catch (err) { settle(q, 'reject', failure(err.message, 'stopped')); }
  }
  // match(msg, head) -> undefined or false when the line is not the answer, MORE for one line of a longer answer, Snbt for
  // the start of a data answer, else the value query() resolves with (null included). Rejects with code timeout, stopped,
  // notRunning, busy, tooLong or badCommand.
  function query(command, match, timeoutMs = 3000, { visible = false } = {}) {
    return write([command], match, timeoutMs, visible);
  }
  function write(lines, match, timeoutMs, visible) {
    return new Promise((resolve, reject) => {
      // A value in a command must not be able to end it and start a second one.
      if (!lines.length || lines.some((line) => typeof line !== 'string' || !line || /[\r\n]/.test(line))) { reject(failure('A console command is one line', 'badCommand')); return; }
      if (state !== 'running') { reject(failure('The server is not running', 'notRunning')); return; }
      if (queue.length >= QUEUE_MAX) { reject(failure('Too many commands are waiting', 'busy')); return; }
      queue.push({ command: lines.join('\n'), match, timeoutMs, visible, resolve, reject, timer: null });
      pump();
    });
  }
  // A command the user asked for: its answer stays in the console. expects: {ok, refused}, the shapes of what the game
  // answers to it, so whatever else lands in the wait is no answer. -> {text, refused}, or null when none came.
  const command = (line, { ok, refused }, timeoutMs = 1500) => query(line, (msg) => {
    if (refused.test(msg)) return { text: msg, refused: true };
    return ok.test(msg) ? { text: msg, refused: false } : undefined;
  }, timeoutMs, { visible: true }).catch((err) => { if (err.code === 'timeout') return null; throw err; });

  // Lines of one change, sent as one write so that nothing of this app's can come between them, and ending with
  // `data get entity <name>`: it is the last thing the server answers, so it also says when the others are over.
  // -> {answers: [{text, refused}], text: that data answer, or null when the player is gone}.
  function batch(lines, name, { ok, refused }, timeoutMs = 5000) {
    const answers = [];
    const data = matchData(name);
    return write(lines, (msg) => {
      const r = data(msg);
      if (r !== undefined) return r;
      if (!refused.test(msg) && !ok.test(msg)) return undefined;
      answers.push({ text: msg, refused: refused.test(msg) });
      return MORE;
    }, timeoutMs, true).then((text) => ({ answers, text }));
  }

  // Answer text from start on -> where the answer ended, or the text's end while it goes on.
  function absorb(text, start) {
    const a = open;
    const found = a.scan.push(text, start);
    const end = found === -1 ? text.length : found;
    if (a.q) {
      a.parts.push(text.slice(start, end));
      a.size += end - start;
      if (a.size > ANSWER_SIZE || a.scan.lines > ANSWER_LINES) {
        settle(a.q, 'reject', failure('The server\'s answer is too long to read', 'tooLong'));
        a.q = null;
        a.parts = [];
      }
    }
    if (found !== -1) {
      open = null;
      if (a.q) settle(a.q, 'resolve', plain(a.parts.join('')).replace(/\r?\n$/, ''));
    }
    return end;
  }
  // q: the query it answers, or null for one that stays in the console. ended: the text is a whole line.
  function openAnswer(q, text, ended) {
    open = { q, shown: !q, scan: snbtEnd(), parts: [], size: 0, until: now() + ANSWER_MS };
    absorb(ended ? `${text}\n` : text, 0);
  }
  // A line is tried on the late queries first, then on the one in flight. The one it answers ends the wait of all before
  // it. A late query is settled already, so its answer is only consumed. -> whether the line is hidden.
  function answer(head, ended) {
    while (late.length && late[0].until < now()) late.shift();
    const waiting = current ? [...late, current] : [...late];
    for (let i = 0; i < waiting.length; i++) {
      const q = waiting[i];
      let r;
      try { r = q.match(head.msg, head); } catch (err) { log(`a query's match failed: ${err.message}`); }
      if (r === undefined || r === false) continue;
      late.splice(0, r === MORE ? i : i + 1);
      if (q !== current && current && r !== MORE) current.robbed = true;
      if (r instanceof Snbt) openAnswer(q, r.text, ended);
      else if (r !== MORE) settle(q, 'resolve', r);
      return r instanceof Snbt || !q.visible;
    }
    return false;
  }

  // ---------- the output ----------
  function setState(next) {
    if (next === 'running' && state === 'starting') { state = 'running'; ping('roster'); }
    else if (next === 'stopping' && state !== 'stopped') { state = 'stopping'; failAll('stopped'); ping('roster'); }
  }
  function apply(ev) {
    switch (ev.type) {
      case 'uuid': uuids.set(ev.name, ev.uuid); return;
      case 'login': setState('running'); joined(ev.name, ev); return;
      // A join line prints the display name. The uuid line and `list uuids` print the name, and only a name they gave is believed.
      case 'join': setState('running'); if (uuids.has(ev.name)) joined(ev.name, {}); return;
      case 'leave': left(ev.name, ev.text); return;
      case 'server': setState(ev.state); return;
      default: {
        const p = online.get(ev.name);
        if (!p) return;
        store.add({ type: ev.type, name: ev.name, uuid: p.uuid, text: ev.text, ...(ev.secure === false && { secure: false }) });
        ping('event');
      }
    }
  }
  // A line -> true when it is a hidden answer. ended is false for the start of a line too long to keep: no event comes of
  // it, but if it starts an answer, what follows it must not parse as lines.
  function take(line, ended = true) {
    const head = split(line);
    if (!head) return false;
    const unasked = head.server ? DATA_ANSWER.exec(head.msg) : null;
    // An entity's custom name can start like chat (<, * , [x] ), and on 1.20.1 a book it holds prints its line breaks raw.
    // No player can send a line break, so chat is one line: a line of both shapes is an answer unless the part before
    // `has the following` holds an online name. An online player can still name an entity after himself.
    if (unasked?.[1] !== undefined && typed(head.msg) && !namesIn(unasked[1], online).length) {
      openAnswer(null, head.msg.slice(unasked[0].length), ended);
      return false;
    }
    if (ended) {
      const ev = classify(head, online);
      if (ev) { apply(ev); return false; }
    }
    if (!head.server || typed(head.msg)) return false;
    if ((current || late.length) && answer(head, ended)) return true;
    if (unasked && !open) openAnswer(null, head.msg.slice(unasked[0].length), ended);
    return false;
  }

  let partial = ''; // the unfinished last line, as the parser needs it
  let held = ''; // the part of it the console has not been given
  let skipping = false; // a line past LINE_MAX: shown, never parsed
  // Without a query in flight the console gets the text exactly as it came, half lines included (a prompt must not wait
  // for a newline). While one is, a half line is held, since it may turn out to be the answer. A line whose start already
  // went to the console cannot be hidden any more, so it stays visible even if it answers.
  function feed(text) {
    let out = '';
    let start = 0;
    while (start < text.length) {
      if (open) {
        if (now() > open.until) { open = null; continue; }
        const { shown } = open;
        const end = absorb(text, start);
        if (shown) out += text.slice(start, end);
        start = end;
        continue;
      }
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      const piece = text.slice(start, nl + 1);
      start = nl + 1;
      const whole = held.length === partial.length;
      const hide = !skipping && take(partial + piece.slice(0, -1)) && whole;
      if (!hide) out += held + piece;
      partial = '';
      held = '';
      skipping = false;
    }
    const rest = text.slice(start);
    if (!skipping) partial += rest;
    if (current && !skipping) held += rest;
    else { out += held + rest; held = ''; }
    if (partial.length > LINE_MAX) {
      const hide = take(partial, false) && held.length === partial.length;
      if (!hide) out += held;
      partial = '';
      held = '';
      skipping = !open;
    }
    return out;
  }
  // startProcess's filter. Anything unexpected here must not reach the process's data event, where it would be uncaught.
  const filter = (text, stream) => {
    if (proxy || stream !== 'out') return text;
    try { return feed(text); } catch (err) {
      log(`the players tap failed: ${err.message}`);
      const out = held + text;
      partial = '';
      held = '';
      return out;
    }
  };
  // startProcess at the process's end: the half line still held.
  filter.flush = () => { const rest = held; partial = ''; held = ''; return rest; };

  // ---------- polling ----------
  async function pollPosition() {
    const names = [...online.keys()];
    const name = names[turn++ % names.length];
    const pos = await query(`data get entity ${name} Pos`, matchData(name), 2000);
    if (pos === null) return;
    const dim = await query(`data get entity ${name} Dimension`, matchData(name), 2000);
    const found = posOf({ Pos: parseSnbt(pos), Dimension: dim === null ? undefined : parseSnbt(dim) });
    const p = online.get(name);
    if (p && found) { p.pos = found; ping('position'); }
  }
  async function tick() {
    if (polling || state !== 'running' || !online.size || current || queue.length) return;
    polling = true;
    try {
      const t = now();
      if (t >= nextList) {
        nextList = t + listMs;
        const listed = await query('list uuids', matchList(), 3000);
        if (listed && state === 'running') reconcile(listed, t);
      } else if (t < watchUntil && hasDataCommand(version)) await pollPosition();
    } catch (err) {
      if (!['timeout', 'stopped', 'notRunning'].includes(err.code)) log(`polling failed: ${err.message}`);
    } finally { polling = false; }
  }
  // The tab is open: positions are polled. A lease, so a window that goes away without saying so does not leave a command
  // per second running into the server's log. The tab repeats this every 10 s; watch(false) ends it.
  const watch = (on) => { watchUntil = on ? now() + WATCH_MS : 0; };

  // ---------- life ----------
  function attach(child) {
    if (!child) { end(); return; }
    proc = child;
    // A proxy's output is not parsed, so no line ever says it is up. Its process running is all the tab can know.
    if (proxy) { state = 'running'; child.on('close', end); return; }
    store.open();
    nextList = now() + listMs;
    poller = setInterval(tick, pollMs);
    poller.unref?.();
    child.on('close', end);
    // "stop" sent (health-monitor.js markStops): one that hangs never prints "Stopping server", and a query would make it print.
    child.on?.('stopAsked', () => setState('stopping'));
  }
  function end() {
    if (state === 'stopped') return;
    state = 'stopped';
    clearInterval(poller);
    open = null;
    failAll('stopped');
    for (const name of [...online.keys()]) left(name, '', 'stopped');
    for (const timer of pings.values()) clearTimeout(timer);
    pings.clear();
    if (!proxy) {
      store.flush();
      notify('roster');
      notify('event');
    }
    onEnd();
  }

  return {
    filter, attach, query, command, batch, watch, end,
    // Something new is on the record, from anywhere but this stream.
    recorded: () => ping('event'),
    get state() { return state; },
    get proxy() { return proxy; },
    get hasData() { return hasDataCommand(version); },
    learn: (map) => { usercache = map; },
    players: () => [...online.values()].map((p) => ({ ...p })),
    find: (uuid) => [...online.values()].find((p) => p.uuid === uuid) ?? null,
  };
}

module.exports = { createSession, matchData, matchList, MORE };
