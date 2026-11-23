// What each nation remembers of this game (plan 5.2): state.memory[n] is n's ledger, a list of
// { hour, about: <nation index>, kind, value } in the order things happened. value is fixed point (1000 = one
// occurrence; a lost province is one per province). Trust (-1000..1000) and grudge (0..1000) toward each nation are
// DERIVED from the ledger every time they are read, never stored: each entry adds KINDS[kind].trust and .grudge
// × value / 1000, faded by its age with the kind's half-life in days. A taken core fades over years, a taken
// non-core province over months.
//
// record() is the only writer. A ledger keeps at most CAP entries; past that the entry whose weight has faded most
// is dropped (oldest first on a tie), so a long war cannot push an old betrayal out of memory.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).memory = api; }
})(() => {
  const CAP = 160;
  // trust and grudge per 1000 of value; half: days for the weight to halve.
  const KINDS = {
    betrayal: { trust: -700, grudge: 600, half: 1500 },
    'attacked-us': { trust: -250, grudge: 300, half: 400 },
    'helped-us': { trust: 300, grudge: -150, half: 500 },
    'took-our-core': { trust: -80, grudge: 250, half: 3000 },
    'took-our-land': { trust: -20, grudge: 60, half: 90 },
    'broke-promise': { trust: -450, grudge: 200, half: 700 },
    'kept-promise': { trust: 300, grudge: -100, half: 500 },
    'defeated-us': { trust: -100, grudge: 250, half: 700 },
    'defeated-them': { trust: 0, grudge: -50, half: 300 },
    'made-peace': { trust: 100, grudge: -100, half: 300 },
  };

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  // 1000 at age 0, halving every `half` days, linear between halvings.
  function fade(ageHours, half) {
    const days = Math.max(0, Math.trunc(ageHours / 24));
    const k = Math.trunc(days / half);
    if (k >= 20) return 0;
    const hi = 1000 >> k;
    const lo = hi >> 1;
    return hi - Math.trunc(((hi - lo) * (days - k * half)) / half);
  }

  const weight = (state, e) => Math.trunc((e.value * fade(state.hour - e.hour, KINDS[e.kind].half)) / 1000);

  function record(ctx, nation, about, kind, value = 1000) {
    const { state } = ctx;
    if (!KINDS[kind] || nation === about || nation < 0 || about < 0) return;
    const list = state.memory[nation] || (state.memory[nation] = []);
    list.push({ hour: state.hour, about, kind, value: value | 0 });
    if (list.length <= CAP) return;
    let worst = 0;
    let wv = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const v = Math.abs(weight(state, e)) * Math.max(Math.abs(KINDS[e.kind].trust), Math.abs(KINDS[e.kind].grudge));
      if (v < wv) { wv = v; worst = i; }
    }
    list.splice(worst, 1);
  }

  // Trust and grudge of `nation` toward every nation, one pass over the ledger.
  function feelings(ctx, nation) {
    const { state } = ctx;
    const k = state.nations.length;
    const trust = new Int32Array(k);
    const grudge = new Int32Array(k);
    for (const e of state.memory[nation] || []) {
      const K = KINDS[e.kind];
      if (!K || e.about < 0 || e.about >= k) continue;
      const w = weight(state, e);
      trust[e.about] += Math.trunc((K.trust * w) / 1000);
      grudge[e.about] += Math.trunc((K.grudge * w) / 1000);
    }
    for (let b = 0; b < k; b++) { trust[b] = clamp(trust[b], -1000, 1000); grudge[b] = clamp(grudge[b], 0, 1000); }
    return { trust, grudge };
  }

  const trust = (ctx, a, b) => feelings(ctx, a).trust[b];
  const grudge = (ctx, a, b) => feelings(ctx, a).grudge[b];

  // The faded value of one kind of entry about b (1000 = one fresh occurrence).
  function amount(ctx, a, b, kind) {
    let sum = 0;
    for (const e of ctx.state.memory[a] || []) if (e.about === b && e.kind === kind) sum += weight(ctx.state, e);
    return sum;
  }

  // For the screens: per other nation with any entry, in index order, its trust and grudge and the lines behind
  // them newest first, each with what it adds now.
  function summary(ctx, nation) {
    const { state } = ctx;
    const f = feelings(ctx, nation);
    const out = [];
    const list = state.memory[nation] || [];
    for (let b = 0; b < state.nations.length; b++) {
      const lines = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.about !== b) continue;
        const w = weight(state, e);
        lines.push({ hour: e.hour, kind: e.kind, value: e.value, trust: Math.trunc((KINDS[e.kind].trust * w) / 1000), grudge: Math.trunc((KINDS[e.kind].grudge * w) / 1000) });
      }
      if (lines.length) out.push({ nation: b, tag: state.nations[b].tag, trust: f.trust[b], grudge: f.grudge[b], lines });
    }
    return out;
  }

  return { record, feelings, trust, grudge, amount, summary, fade, KINDS, CAP };
});
