// Speaker labels' pure half (docs/cut-architecture.md, Cut.speakers): who speaks when, from speaker embeddings of
// the speech that recognition found, tested in Node (verify/cut-speakers-core.mjs). ui-speakers.js reads the sound and
// asks main/cut/speakers.js (WeSpeaker ResNet34-LM in a Python sidecar) for one embedding per window.
//
// - Windows: a transcript's words (source seconds) split at pauses of `gap` s and after sentence ends into segments; a
//   segment up to `short` s is one window, a longer one is covered by windows of `size` s every `hop` s. A window shorter than `min` s takes
//   the silence around it, up to half of the pauses on each side.
// - Clusters: agglomerative, average linkage on cosine similarity (NN-chain, so the whole tree costs O(n^2)), cut where
//   clusters stop being similar (`threshold`) for Auto, or at a fixed number of speakers. Windows shorter than `trust`
//   s are left out of the tree and clusters with less than `minSpeech` s of speech are strays; both join the nearest
//   speaker. A fixed count is reached from a finer cut by joining the most alike clusters.
// - Words: each word takes the speaker its windows vote for (overlap times reliability); inside a segment a run of a
//   speaker shorter than `minRun` s is a flip of the embedding, not a turn, and joins the longer side.
// - Turns: per media file, [[t0, t1, id]] source seconds, sorted and apart; what the project keeps (project.speakers)
//   and what a person changes by hand (assign).
// - Captions: a track's style says whether its captions show their speaker's color (speakerColor) and name
//   (speakerName, as "Name: text"); decorate gives the compositor and the SRT writer the shown text and color.
// project.speakers: {list: [{id: 'sp1', name: '' (shown as "Speaker 1"), color: '#rrggbb'}], turns: {mediaId: turns},
// count: 0 (Auto) or the fixed number of speakers the labels were made with}.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).speakers = api;
})(() => {
  // Readable on the caption background (#00000099) and on both themes' panels.
  const PALETTE = ['#4fc3f7', '#ffb74d', '#81c784', '#f06292', '#ba68c8', '#fff176', '#4db6ac', '#e57373', '#90a4ae', '#a1887f'];
  const MAX = 10;
  // Tuned on the speaker benchmark (docs/cut-architecture.md, Cut.speakers).
  const DEFAULTS = { gap: 0.3, sentences: true, short: 4, size: 3, hop: 1.5, min: 1, trust: 0.8, threshold: 0.5, minSpeech: 2.5, spare: 3, minRun: 1, limit: 1500 };

  // ---- windows -------------------------------------------------------------------------------------------------------

  // Words [{t0, t1, text}] (seconds, in time order) -> [[first, last]] word indexes of the runs without a pause of
  // `gap`, also split after a sentence's end (`sentences`): in noise Whisper's word times lose the pause between two
  // speakers, and a window across the change is neither of them.
  const END = /[.?!。？！…]["'”’)\]]*$/;
  function segments(words, { gap = DEFAULTS.gap, sentences = DEFAULTS.sentences } = {}) {
    const out = [];
    words.forEach((w, i) => {
      const last = out[out.length - 1];
      const prev = words[last?.[1]];
      if (last && w.t0 - prev.t1 < gap && !(sentences && END.test(String(prev.text || '')))) last[1] = i;
      else out.push([i, i]);
    });
    return out;
  }
  // -> [{t0, t1, seg, speech}]: the windows to embed (seconds), `speech` the seconds of words inside.
  function windowsOf(words, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const segs = segments(words, o);
    const out = [];
    segs.forEach(([i, j], s) => {
      const a = words[i].t0;
      const b = words[j].t1;
      const len = b - a;
      if (len <= o.short) {
        let [x, y] = [a, b];
        if (len < o.min) {
          const before = s > 0 ? (a - words[segs[s - 1][1]].t1) / 2 : Infinity;
          const after = s + 1 < segs.length ? (words[segs[s + 1][0]].t0 - b) / 2 : Infinity;
          // half of what is missing on each side; what one side cannot take goes to the other
          const room0 = Math.min(before, a);
          const want = (o.min - len) / 2;
          const left = Math.min(want, room0);
          const right = Math.min(after, o.min - len - left);
          x = a - Math.min(room0, o.min - len - right);
          y = b + right;
        }
        out.push({ t0: x, t1: y, seg: s, speech: len });
        return;
      }
      const n = Math.ceil((len - o.size) / o.hop) + 1;
      const step = (len - o.size) / (n - 1);
      for (let k = 0; k < n; k++) out.push({ t0: a + k * step, t1: a + k * step + o.size, seg: s, speech: o.size });
    });
    return out;
  }

  // ---- clustering ----------------------------------------------------------------------------------------------------

  const unit = (v) => {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  };
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };
  // The average-linkage tree of unit vectors: [{a, b, sim}] merges (indexes of the items, a cluster named by its first
  // item), most similar first. NN-chain: average linkage is reducible, so merging reciprocal nearest neighbours gives
  // the greedy tree.
  function tree(vecs) {
    const n = vecs.length;
    const sum = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const s = dot(vecs[i], vecs[j]); sum[i * n + j] = s; sum[j * n + i] = s; }
    const size = new Array(n).fill(1);
    const alive = new Array(n).fill(true);
    const avg = (i, j) => sum[i * n + j] / (size[i] * size[j]);
    const merges = [];
    const chain = [];
    let left = n;
    while (left > 1) {
      if (!chain.length) chain.push(alive.indexOf(true));
      const a = chain[chain.length - 1];
      const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
      let best = prev;
      let bestSim = prev >= 0 ? avg(a, prev) : -Infinity;
      for (let j = 0; j < n; j++) {
        if (!alive[j] || j === a || j === prev) continue;
        const s = avg(a, j);
        if (s > bestSim) { bestSim = s; best = j; }
      }
      if (best === prev) {
        chain.pop();
        chain.pop();
        const [keep, drop] = a < prev ? [a, prev] : [prev, a];
        merges.push({ a: keep, b: drop, sim: bestSim });
        for (let j = 0; j < n; j++) {
          if (!alive[j] || j === keep || j === drop) continue;
          const s = sum[keep * n + j] + sum[drop * n + j];
          sum[keep * n + j] = s;
          sum[j * n + keep] = s;
        }
        size[keep] += size[drop];
        alive[drop] = false;
        left--;
      } else chain.push(best);
    }
    return merges.sort((x, y) => y.sim - x.sim);
  }
  // The clusters after the merges whose similarity is at least `threshold`, or the first n - count merges.
  function cut(n, merges, { threshold = null, count = null }) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const root = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    let groups = n;
    for (const m of merges) {
      if (count != null ? groups <= count : m.sim < threshold) break;
      const ra = root(m.a);
      const rb = root(m.b);
      if (ra !== rb) { parent[rb] = ra; groups--; }
    }
    return Array.from({ length: n }, (_, i) => root(i));
  }
  // Embeddings (one per window, any numeric arrays) and the windows' speech seconds -> a speaker index per window
  // (0, 1, ... in order of first appearance; -1 for a window with no embedding). count: null (Auto) or a number.
  function cluster(embeddings, speech, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const vecs = embeddings.map((e) => (e && e.length ? unit(e) : null));
    const usable = vecs.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const out = new Array(vecs.length).fill(-1);
    if (!usable.length) return out;
    // the tree is made of the trusted windows (all of them when none is long enough), at most `limit`, evenly spread
    let core = usable.filter((i) => speech[i] >= o.trust);
    if (!core.length) core = usable;
    if (core.length > o.limit) core = Array.from({ length: o.limit }, (_, k) => core[Math.floor((k * core.length) / o.limit)]);
    const merges = tree(core.map((i) => vecs[i]));
    const want = o.count == null || o.count <= 0 ? null : Math.min(MAX, Math.round(o.count));
    const groupsOf = (roots) => {
      const groups = new Map();
      roots.forEach((r, k) => {
        const i = core[k];
        const g = groups.get(r) || { sum: new Float64Array(vecs[i].length), speech: 0 };
        for (let d = 0; d < g.sum.length; d++) g.sum[d] += vecs[i][d];
        g.speech += speech[i];
        groups.set(r, g);
      });
      return [...groups.values()];
    };
    // Clusters with too little speech are stray windows (in a short recording a speaker may have less than
    // minSpeech: then 15% of the speech is enough).
    const enough = Math.min(o.minSpeech, 0.15 * core.reduce((n, i) => n + speech[i], 0));
    let big;
    if (want == null) {
      const groups = groupsOf(cut(core.length, merges, { threshold: o.threshold }));
      big = groups.filter((g) => g.speech >= enough);
      if (!big.length) big = [groups.reduce((x, y) => (y.speech > x.speech ? y : x))];
    } else {
      // A fixed count: the tree cut `spare` clusters finer, the strays left out (while more than `want` remain),
      // then the two most alike clusters joined until `want` are left. Cutting the tree at `want` itself kept one odd
      // 1 s window as a speaker and joined two real speakers instead.
      big = groupsOf(cut(core.length, merges, { count: Math.min(core.length, want + o.spare) })).sort((x, y) => y.speech - x.speech);
      while (big.length > want && big[big.length - 1].speech < enough) big.pop();
      while (big.length > want) {
        let pair = [0, 1];
        let most = -Infinity;
        for (let x = 0; x < big.length; x++) {
          for (let y = x + 1; y < big.length; y++) {
            const s = dot(unit(big[x].sum), unit(big[y].sum));
            if (s > most) { most = s; pair = [x, y]; }
          }
        }
        const [x, y] = pair;
        for (let d = 0; d < big[x].sum.length; d++) big[x].sum[d] += big[y].sum[d];
        big[x].speech += big[y].speech;
        big.splice(y, 1);
      }
    }
    big = big.slice(0, MAX);
    const cents = big.map((g) => unit(g.sum));
    for (const i of usable) {
      let best = 0;
      let bestSim = -Infinity;
      cents.forEach((c, k) => { const s = dot(vecs[i], c); if (s > bestSim) { bestSim = s; best = k; } });
      out[i] = best;
    }
    // numbered by first appearance
    const order = new Map();
    for (const k of out) if (k >= 0 && !order.has(k)) order.set(k, order.size);
    return out.map((k) => (k >= 0 ? order.get(k) : -1));
  }

  // ---- words and turns -----------------------------------------------------------------------------------------------

  // A speaker index per word from the windows' indexes (-1 where no window says). Inside a segment, runs shorter than
  // minRun join the longer neighbouring run.
  function wordLabels(words, windows, labels, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const out = words.map(() => -1);
    const votes = words.map(() => new Map());
    let start = 0;
    windows.forEach((win, k) => {
      const lab = labels[k];
      if (lab == null || lab < 0) return;
      const weight = Math.min(1, (win.t1 - win.t0) / o.size);
      while (start < words.length && words[start].t1 <= win.t0 - o.size) start++;
      for (let i = start; i < words.length && words[i].t0 < win.t1; i++) {
        const w = words[i];
        const ov = Math.min(w.t1, win.t1) - Math.max(w.t0, win.t0);
        if (ov > 0 || (w.t1 <= w.t0 && w.t0 >= win.t0 && w.t0 < win.t1)) votes[i].set(lab, (votes[i].get(lab) || 0) + weight * Math.max(ov, 1e-3));
      }
    });
    votes.forEach((v, i) => {
      let best = -1;
      let most = 0;
      for (const [lab, n] of v) if (n > most) { most = n; best = lab; }
      out[i] = best;
    });
    for (const [i, j] of segments(words, o)) smoothRuns(words, out, i, j, o.minRun);
    return out;
  }
  function smoothRuns(words, labels, i, j, minRun) {
    for (let pass = 0; pass < 4; pass++) {
      const runs = [];
      for (let k = i; k <= j; k++) {
        const last = runs[runs.length - 1];
        if (last && labels[k] === last.lab) last.j = k;
        else runs.push({ lab: labels[k], i: k, j: k });
      }
      if (runs.length < 2) return;
      const len = (r) => words[r.j].t1 - words[r.i].t0;
      let changed = false;
      runs.forEach((r, k) => {
        if (len(r) >= minRun) return;
        const before = runs[k - 1];
        const after = runs[k + 1];
        const into = !before ? after : !after ? before : len(before) >= len(after) ? before : after;
        if (!into || into.lab === r.lab || len(into) < len(r)) return;
        for (let x = r.i; x <= r.j; x++) labels[x] = into.lab;
        changed = true;
      });
      if (!changed) return;
    }
  }
  // Words (seconds) and their speaker ids (null: none) -> turns [[t0, t1, id]]: a turn runs from its first word to its
  // last, and the silence between two speakers is split in the middle so every moment of speech has a speaker. Word
  // times can overlap (windows joined by mergeWindows), so a turn starts where the turn kept before it ends, a turn
  // that leaves nothing is dropped, and the turns on either side of it join when they are one speaker's.
  function turnsOf(words, ids) {
    const runs = [];
    words.forEach((w, i) => {
      const id = ids[i];
      if (id == null) return;
      const last = runs[runs.length - 1];
      if (last && last[2] === id) last[1] = Math.max(last[1], w.t1);
      else runs.push([w.t0, Math.max(w.t1, w.t0 + 0.01), id]);
    });
    const kept = [];
    for (const [t0, t1, id] of runs) {
      const last = kept[kept.length - 1];
      if (last && last[2] === id) { last[1] = Math.max(last[1], t1); continue; }
      let a = t0;
      if (last && a > last[1]) { a = (last[1] + a) / 2; last[1] = a; } else if (last) a = last[1];
      if (t1 > a) kept.push([a, t1, id]);
    }
    const out = [];
    for (const [t0, t1, id] of kept) {
      const last = out[out.length - 1];
      const a = Math.max(round(t0), last ? last[1] : -Infinity);
      const b = round(t1);
      if (b <= a) continue;
      if (last && last[2] === id) last[1] = Math.max(last[1], b);
      else out.push([a, b, id]);
    }
    return out;
  }
  const round = (x) => Math.round(x * 1000) / 1000;
  // The speaker id at source second t: the turn holding it, else the nearest turn within `reach` s.
  function at(turns, t, reach = 1) {
    if (!turns?.length) return null;
    let lo = 0;
    let hi = turns.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (turns[m][0] <= t) lo = m; else hi = m - 1; }
    const a = turns[lo];
    if (a[0] <= t && t < a[1]) return a[2];
    let best = null;
    let d = reach;
    for (const k of [lo - 1, lo, lo + 1]) {
      const x = turns[k];
      if (!x) continue;
      const dist = t < x[0] ? x[0] - t : t - x[1];
      if (dist <= d) { d = dist; best = x[2]; }
    }
    return best;
  }
  // Turns with [a, b) given to speaker `id` (the turns around it trimmed or split, neighbours of the same speaker
  // joined).
  function assign(turns, a, b, id) {
    const out = [];
    for (const [x, y, s] of turns || []) {
      if (y <= a || x >= b) { out.push([x, y, s]); continue; }
      if (x < a) out.push([x, a, s]);
      if (y > b) out.push([b, y, s]);
    }
    out.push([a, b, id]);
    out.sort((p, q) => p[0] - q[0]);
    const joined = [];
    for (const t of out) {
      const last = joined[joined.length - 1];
      if (last && last[2] === t[2] && t[0] - last[1] < 1e-6) last[1] = t[1];
      else joined.push([t[0], t[1], t[2]]);
    }
    return joined.map(([x, y, s]) => [round(x), round(y), s]);
  }
  // New labels matched to the speakers of before, so a speaker keeps its name and color when the labels are made again
  // (the most shared time first). oldTurns, newTurns: {mediaId: turns}; newIds: the new labels.
  // -> Map new label -> old id (labels without a match are absent).
  function match(oldTurns, newTurns, newIds) {
    const shared = new Map();
    for (const [media, list] of Object.entries(newTurns || {})) {
      const old = oldTurns?.[media] || [];
      for (const [a, b, n] of list) {
        for (const [x, y, o] of old) {
          const ov = Math.min(b, y) - Math.max(a, x);
          if (ov > 0) shared.set(`${n}\n${o}`, (shared.get(`${n}\n${o}`) || 0) + ov);
        }
      }
    }
    const out = new Map();
    const used = new Set();
    for (const [key] of [...shared].sort((p, q) => q[1] - p[1])) {
      const [n, o] = key.split('\n');
      if (out.has(n) || used.has(o) || !newIds.includes(n)) continue;
      out.set(n, o);
      used.add(o);
    }
    return out;
  }
  // The speaker list for the labels `count` (0, 1, ...): the matched speakers of before keep their entry; new ones get
  // the next free id and a color not used yet. `taken`: ids named elsewhere (inUse), never given to a new speaker.
  // -> {list, ids: id per label}
  function listFor(count, before, matched, taken = []) {
    const old = before?.list || [];
    const ids = [];
    const list = [];
    const usedColors = new Set();
    for (let k = 0; k < count; k++) {
      const o = matched.get(String(k));
      const prev = o && old.find((s) => s.id === o);
      if (prev) { ids[k] = prev.id; list[k] = { ...prev }; usedColors.add(prev.color); }
    }
    let next = [...old.map((s) => s.id), ...taken].reduce((m, id) => Math.max(m, Number(/^sp(\d+)$/.exec(id)?.[1]) || 0), 0) + 1;
    for (let k = 0; k < count; k++) {
      if (list[k]) continue;
      const id = `sp${next++}`;
      const color = PALETTE.find((c) => !usedColors.has(c)) || PALETTE[k % PALETTE.length];
      usedColors.add(color);
      ids[k] = id;
      list[k] = { id, name: '', color };
    }
    return { list, ids };
  }
  // Every speaker id the project names: its list and the captions of every sequence. A caption keeps its id after the
  // speaker leaves the list (Change Speaker, labels made again in another sequence), so a new speaker given that id
  // would lend it their name and color.
  function inUse(project) {
    const ids = new Set((project?.speakers?.list || []).map((s) => s.id));
    for (const seq of project?.sequences || []) for (const ct of seq.captions || []) for (const it of ct.items) if (it.speaker) ids.add(it.speaker);
    return [...ids];
  }

  // ---- names and captions --------------------------------------------------------------------------------------------

  // The name shown for a speaker: its own, else "Speaker N" (N its place in the list) through `tr`.
  function nameOf(sp, id, tr = (s, p) => s.replace('{n}', p.n)) {
    const list = sp?.list || [];
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return '';
    return list[i].name || tr('Speaker {n}', { n: i + 1 });
  }
  const colorOf = (sp, id) => sp?.list?.find((s) => s.id === id)?.color || null;
  // Words (timeline, with `speaker`) split into runs of one speaker, for captions that never mix two speakers.
  function runsOf(words) {
    const out = [];
    for (const w of words) {
      const last = out[out.length - 1];
      if (last && last.speaker === (w.speaker ?? null)) last.words.push(w);
      else out.push({ speaker: w.speaker ?? null, words: [w] });
    }
    return out;
  }
  // A caption as shown: the speaker's name before its text (style.speakerName) and its color (style.speakerColor).
  // -> {prefix: '' or 'Name: ', color: null or '#rrggbb'}
  function shown(sp, style, item, tr) {
    const id = item?.speaker;
    const known = !!id && !!sp?.list?.some((s) => s.id === id);
    return {
      prefix: known && style?.speakerName ? `${nameOf(sp, id, tr)}: ` : '',
      color: known && style?.speakerColor ? colorOf(sp, id) : null,
    };
  }
  // compositor.captionsAt's [{style, items}] with each item's `prefix` and `color` for textrender.drawCaptions.
  function decorate(project, captions, tr) {
    const sp = project?.speakers;
    if (!sp?.list?.length) return captions;
    return captions.map((c) => (c.style?.speakerName || c.style?.speakerColor
      ? { ...c, items: c.items.map((it) => { const s = shown(sp, c.style, it, tr); return { ...it, prefix: s.prefix, ...(s.color ? { color: s.color } : {}) }; }) }
      : c));
  }
  // A track's items with the speaker's name written into the text, for a file (SRT, VTT).
  function written(project, track, items, tr) {
    const sp = project?.speakers;
    if (!sp?.list?.length || !track?.style?.speakerName) return items;
    return items.map((it) => { const p = shown(sp, track.style, it, tr).prefix; return p ? { ...it, text: p + it.text } : it; });
  }

  return {
    PALETTE, MAX, DEFAULTS,
    segments, windowsOf, tree, cut, cluster, wordLabels, turnsOf, at, assign, match, listFor, inUse, nameOf, colorOf, runsOf, shown, decorate, written,
  };
});
