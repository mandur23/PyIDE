// Daily weather per land province (state.prov.weather, an index into rules.weather: clear rain mud snow frost) from
// its climate zone, the season of the day of year and the seeded generator. With rules.weatherPersist permille a
// province keeps yesterday's weather when the season still allows it, so rain turns into mud spells rather than
// flickering. Sea zones stay clear. The effects (move, attack, supply) are read by movement, combat and supply.
// The calendar has 365-day years: parse('YYYY-MM-DD') and date(state) give { year, doy } (doy from 0).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).weather = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;

  const dayOfYear = (state) => (state.doy0 + Math.floor(state.hour / 24)) % 365;
  const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function parse(text) {
    const [y, mo, d] = String(text || '1914-06-28').split('-').map((x) => parseInt(x, 10));
    let doy = d - 1;
    for (let i = 0; i < mo - 1; i++) doy += MONTHS[i];
    return { year: y, doy };
  }

  function date(state) {
    const t = state.doy0 + Math.floor(state.hour / 24);
    return { year: state.year0 + Math.floor(t / 365), doy: t % 365 };
  }

  // 0 winter, 1 spring, 2 summer, 3 autumn.
  function season(rules, doy) {
    const s = rules.seasonStarts;
    if (doy < s[0] || doy >= s[3]) return 0;
    return doy < s[1] ? 1 : doy < s[2] ? 2 : 3;
  }

  function daily(ctx) {
    const { state, rules } = ctx;
    const m = M.of(ctx);
    const w = state.prov.weather;
    const sn = season(rules, dayOfYear(state));
    for (let p = 1; p < m.n; p++) {
      if (m.sea[p]) { w[p] = 0; continue; }
      const probs = rules.climates[m.climate[p]].seasons[sn];
      if (probs[w[p]] > 0 && R.int(state.rng, 1000) < rules.weatherPersist) continue;
      let roll = R.int(state.rng, 1000);
      let k = 0;
      while (k < probs.length - 1 && roll >= probs[k]) { roll -= probs[k]; k++; }
      w[p] = k;
    }
  }

  return { daily, season, dayOfYear, parse, date };
});
