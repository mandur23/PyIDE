// The record of why an AI chose what it chose (the plan's "판단 보기", section 5.5): every AI layer calls record()
// with the option it took, the best alternatives and the factors that moved the score most, and the screens read
// recent(). The record is part of the state (nation.ai.decisions), so a save keeps it and it is hashed like the rest.
//
// A label is an English key the screens translate, with `args` for its names and numbers
// ({ label: 'offensive-toward', args: { province: 1234 } }). Scores and deltas are fixed point, 1000 = 1.0.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).explain = api; }
})(() => {
  const CAP = 40;
  const OPTIONS = 3;
  const FACTORS = 3;

  // decision: { layer: 'nation' | 'operations' | 'general', chosen: { label, args }, options: [{ label, args, score }],
  //             factors: [{ label, args, delta }] }; options are kept best first, factors largest |delta| first.
  function record(ctx, nation, decision) {
    const ai = ctx.state.nations[nation].ai;
    const list = ai.decisions || (ai.decisions = []);
    const options = (decision.options || []).slice().sort((a, b) => b.score - a.score).slice(0, OPTIONS);
    const factors = (decision.factors || []).slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, FACTORS);
    list.push({ hour: ctx.state.hour, layer: decision.layer, chosen: decision.chosen, options, factors });
    if (list.length > CAP) list.splice(0, list.length - CAP);
  }

  // Newest first.
  function recent(ctx, nation, count = CAP) {
    const list = ctx.state.nations[nation].ai.decisions || [];
    return list.slice(-count).reverse();
  }

  return { record, recent, CAP };
});
