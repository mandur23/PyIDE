# Nano Studio Conquest: architecture

The contract the simulation, the map data, the map view and the screens share. The plan and its stages are in [strategy-game-plan.md](strategy-game-plan.md) (Korean). This file is the reference for module boundaries and data shapes; a module's own header comment holds its details. Change a shape here in the same change that changes the code.

## 1. Layout

```
renderer/features/conquest/
  plugin.json            "modes": ["conquest"], "requiredIn": ["conquest"], "main": ["conquest.js"]
  index.js               loads the view and ui scripts in order, starts on ide.on('conquestReady')
  style.css, locales/ko.json
  sim/                   the simulation and the AI: no DOM, no ide, no clock, no Math.random
    modules.json         the load order of every file under sim/ (the worker, Node tests and index.js read it)
    rng.js fixed.js mapdata.js state.js orders.js movement.js combat.js supply.js weather.js naval.js
    industry.js diplomacy.js events.js tick.js hash.js save.js mapgen.js queries.js host.js
    ai/                  nation.js memory.js operations.js general.js mil-common.js personality.js explain.js
  view/                  WebGL2 map: view.js gl.js camera.js pick.js units.js arrows.js raster.js synthetic.js
  ui/                    screens and panels
  data/
    units.json           branches, their stats and counters (section 5)
    world-1914/          map.json, ids.png, scenario.json (sections 3 and 4)
main/features/conquest.js      IPC: saves, the worker source, the optional LLM wording
tools/build-conquest-maps.mjs  builds data/world-1914 from Natural Earth (development only, not shipped)
verify/conquest-*.mjs          tests
```

Every file under `sim/` is a UMD module in the shape of `renderer/features/cut/model.js`: in Node it `require`s its neighbours and sets `module.exports`; elsewhere it reads and extends `globalThis.Conquest` (`Conquest.rng`, `Conquest.state`, ..., `Conquest.ai.nation`). Decide with `typeof module === 'object' && !!module.exports`, not `typeof require` (Monaco makes `require` a page global).

The page's CSP allows workers only from `blob:` and no `fetch`. The simulation worker is therefore built from text: `conquest:workerSource` (main) returns the files of `sim/modules.json` joined in order, and the page starts `new Worker(URL.createObjectURL(new Blob([text])))`. `sim/host.js` is last in the list and is the worker's message loop.

## 2. Determinism

The same map, scenario, seed and orders give the same state on every machine. Saves, replays, tests and later online play (orders only) rest on this.

- Whole numbers only in state. Rates and factors are fixed point, 1000 = 1.0 (`fixed.js`: `mul(a, b)`, `div(a, b)` round toward zero; `isqrt` is integer Newton).
- One generator, `rng.js` (xoshiro128**, state is four int32 in `state.rng`, seeded by splitmix32; `rng.int(state.rng, n)` for n up to 2^21). No `Math.random`, `Date`, or float math that feeds state. `Math.sqrt`, `sin` and friends are not used on the state path. `mapgen.js` has its own generator and may use floats for map data that is not state (lon, lat, colours).
- Iterate arrays by index and provinces, nations and divisions in id order. Never iterate an object's keys or a `Set`/`Map` built from unordered input when the order can change a result. Searches break ties by province id (supply), or by cost plus estimate and then province id (paths).
- What is derived from map, scenario, rules or state (`mapdata.js`, `units.js`, the path search's landmarks and buffers) is cached in `WeakMap`s, never in state, so a cache cannot make two runs differ. Such a cache may depend only on map, scenario and rules, or on state through a key that changes with it (relations are cached per state and hour; `mapdata.writeRel(state, tagA, tagB, patch)` is the one writer of `state.rel` and drops them, `touchRelations(state)` drops them too, `tick` rebuilds them every hour before movement). The AI's board view (`ai/mil-common.js` `view`, where the divisions stand) is keyed by the hour and by `mapdata.board(state)`, a count `tick` raises before each hour's layers (`touchBoard`): a query asked between hours (the staff's `suggestFronts`, `attackOdds`) builds the view before that hour's movement, and without the count the layers reused it, so what the player asked changed how the game went.
- The order of the hour is data: `tick.ORDER` names the systems and the AI layers in the order they run, and `addSystem`/`addLayer` place each by it, so the order the files load in (Node's `require`s, the worker's `modules.json`) cannot change a result. `verify/conquest-ai.mjs` checks that a game gives the same hashes with the files required in either order.
- Float math is allowed off the state path only where every value is a whole number a double holds exactly (sums and products of integers, then `Math.trunc` of a quotient); the path search's landmark bounds are built that way.
- `hash.js` `hash(state)` is a stable 32-bit FNV-1a over the state, object fields in sorted key order, as 8 hex digits; a typed array hashes like the plain array `save.js` writes. Tests compare it day by day (`verify/conquest-engine.mjs`).

## 3. Map data (static): `map.json` and `ids.png`

```js
{ v: 1, id: 'world', name: 'World',
  texture: { file: 'ids.png', width: 8192, height: 4096 },
  projection: { type: 'equirect', lon0: -180, lat0: 90, pxPerDeg: 22.7555 },   // x = (lon - lon0) * pxPerDeg, y = (lat0 - lat) * pxPerDeg
  provinces: [null,                                  // index = province id, ids are 1..N without gaps
    { id: 1, name: 'Marne', sea: false, iso: 'FRA',  // iso: today's country (information only)
      x: 4188, y: 927,                               // label and unit anchor, texture pixels, inside the province
      lon: 4.03, lat: 49.26, area: 8162,             // km2, whole number
      terrain: 'plains',                             // plains forest hills mountain marsh desert urban
      climate: 'temperate',                          // arctic cold temperate mediterranean arid tropical
      coastal: false, port: false,                   // coastal = a sea zone in adj; port = coastal and can load and supply by sea
      adj: [2, 7, 9],                                // land neighbours, its sea zones when coastal, strait partners; symmetric
      river: [7] },                                  // the subset of adj (land only) whose shared border follows a river
    { id: 5801, name: 'North Sea', sea: true, x, y, lon, lat, area, adj: [...] } ],   // adj: touching zones, passages, coastal land
  straits: [[120, 455]],                             // land pairs joined across water (a < b); each is in the other's adj
  passages: [[5805, 5811]] }                         // sea zone pairs joined through water too narrow for the texture; in adj
```

`ids.png` is RGB, no alpha, no colour profile: a pixel's province id is `r << 16 | g << 8 | b`, 0 where there is nothing (south of 66°S; Antarctica is left out). The view samples it with NEAREST and colours a pixel from a lookup texture indexed by id; borders are where neighbouring pixels differ, with the x edges wrapping (x 0 and 8191 are neighbours).

Land provinces come first (ids 1..L, ordered by `iso` then name), sea zones after them (L+1..N); `sea` tells them apart. Two provinces are neighbours when they share at least two pixel edges, so a diagonal touch is not one. Every land province reaches every other through `adj` (land, straits and sea zones together). Lakes other than the Caspian are part of the land provinces around them; the Caspian is a sea zone with no passage out.

The 1914 world has about 5,700 land provinces and 100 sea zones. A province starts as a modern admin-1 unit and is sized by theatre (`tools/conquest-data/theatres.json`): in the war theatres (the Western, Italian, Eastern, Balkan and Caucasus fronts, Anatolia, the Levant and Mesopotamia) about the size of a French department (target 7,500 km2, none over twice that, small units joined up to at least 300 km2), 15,000 to 20,000 km2 in the rest of Europe, Japan and Korea, the eastern United States, north China, the Nile and coastal colonies, 40,000 km2 elsewhere and up to 200,000 km2 in deserts, the Arctic and other empty interiors. A unit over its target is cut on its own pixels into compact parts; a part is named for the largest place in it, else for its unit and a wind (`Bayern North-East`), and names are unique within a nation. Every province is one 4-connected region in the texture apart from islands, enclaves inside another nation and a few real exclaves.

A generated map (`mapgen.js`) has the same shape and can carry `cells` (polygons per province) instead of `texture`; the view rasterises those into an id canvas itself.

## 4. Scenario (static): `scenario.json`

```js
{ v: 1, id: '1914', map: 'world', name: 'The Great War', start: '1914-06-28', end: '1920-01-01',
  nations: [
    { tag: 'FRA', name: 'France', color: '#6f9ee0', capital: 1234, bloc: 'entente',   // entente central null; capital is owned
      major: true, manpower: 3800000,
      personality: { boldness: 60, caution: 40, loyalty: 75, revanchism: 90 },         // 0..100
      goals: [{ id: 'alsace-lorraine', kind: 'take', provinces: [..], weight: 900 },   // weight 0..1000
              { id: 'belgium', kind: 'defend', nation: 'BEL', weight: 500 }],
      generals: [{ name: 'Joseph Joffre', trait: 'defence' }],                         // offence defence terrain logistics
      templates: [{ id: 'inf14', name: 'Infantry Division (1914)', line: ['inf','inf','inf','inf','inf','inf','inf','inf','art','art','mg','mg'], support: ['eng','cav'] }],
      lines: [{ item: 'rifles', factories: 6 }],     // items rifles guns mgs shells horses; sum <= the nation's mil factories
      navy: 36,                                      // whole number >= 0, relative fleet strength; 0 for a nation without a port
      stock: { rifles: 33450, guns: 1220, heavy: 90, mgs: 1070, shells: 243750, horses: 25130 },   // starting equipment, whole numbers
      mob: { peace: 400, days: 16 } } ],             // readiness before mobilising (0..1000) and the days to full; absent = always full
  owner: { FRA: [1, 2, 3], DEU: [..] },              // every land province exactly once; controller = owner at the start
  cores: { DEU: [..], FRA: [..] },                   // absent nation = its owned provinces; a present list is complete; a province may be core to several
  provinces: { 1234: { mil: 4, civ: 6, infra: 4, hub: true, coal: 0, iron: 2, oil: 0 } },   // absent field = { mil 0, civ 0, infra 2, hub false, coal 0, iron 0, oil 0 }
  armies: [{ nation: 'FRA', name: '5e Armée', general: 'Charles Lanrezac', template: 'inf14', divisions: 12, at: [1234, 1240] }],   // general may be null; at = own provinces
  alliances: [['FRA', 'RUS'], ['DEU', 'AUT']], wars: [],   // treaties in force; they never bring a nation into a war by themselves
  events: [{ id: 'aut-declares-srb', once: true, skipIfPlayer: 'AUT', when: { .. }, effects: [ .. ] }] }   // skipIfPlayer optional
```

Every nation has every field; a minor nation's come from defaults (a hold goal on its capital, one infantry template, lines from its factories, manpower from area and factories, navy 1 with a port and 0 without). `navy` ranks the fleets of 1914: Britain first, then Germany, the United States, France, Japan, Russia, Italy, Austria-Hungary and the Ottomans, small navies small. `stock` is a base plus an amount per division of the nation's starting armies, half again for a great power (more heavy guns for Germany and Austria-Hungary); the engine uses `rules.start.stock` for a nation without one. `mob` is the 1914 war plans' timetable in spirit: Germany 450 and 13 days, France 400 and 16, Britain 700 and 14 (a small army that is ready), Austria-Hungary 350 and 24, Russia 300 and 45, Belgium 250 and 30, the Ottomans 250 and 50, other nations 400 and 30. An army stands in the province of its city and, where that province was cut into parts, in the parts of it around the city; a goal, core or event that names a region takes every part of it. Colonies and protectorates are owned by the metropole's tag. A nation's `cores` list, when present, is its home provinces and claims; colonies are not cores. `notes` (text) says what is a game value.

An event whose effect would be refused (a war already being fought, peace with someone not at war) still fires: its other effects apply and its id goes to `state.fired`, so a chain that waits on it (`daysSince`) goes on even when an AI got there first.

Goals (`kind`): `take` { provinces } wants them; `hold` { provinces } keeps them; `defend` { nation } protects that nation; `join` { bloc, when, provinces? } is ready to join `bloc` once `when` holds, at the price of being promised `provinces` when given.

Events: each is checked once a day in array order. `once: true` (the only kind in 1914) fires at most once and its id goes to `state.fired`. `skipIfPlayer: tag` means the event never fires when the player plays that tag (the player decides instead): the `decisions { nation }` query lists those of them that would declare war for that nation, have not fired and whose `when` holds now (`events.holds`, the same test with every `chance` counted as true, so a query never rolls the rng), as `[{ id, wars: [nation] }]`, and `ui/decisions.js` pauses the game and asks the player once a game (the ids asked are kept in the save's meta as `decisions`); Declare War sends ordinary `declare-war` orders. All effects of an event apply in order on the hour it fires.

Conditions (`when` and a `join` goal's `when`; one key per object):

| Condition | True when |
| --- | --- |
| `{ all: [c, ..] }` / `{ any: [c, ..] }` / `{ not: c }` | every / some / not |
| `{ war: [A, B] }` | A and B are at war with each other |
| `{ atWar: A }` | A is at war with anyone |
| `{ ally: [A, B] }` | A and B are allied |
| `{ bloc: [A, 'entente' \| 'central' \| null] }` | A is in that bloc |
| `{ controls: [A, [ids]] }` / `{ controlsAny: [A, [ids]] }` | A controls all / at least one of the provinces |
| `{ fatigueAbove: [A, n] }` | A's war fatigue is above n (0..1000) |
| `{ dateAfter: 'YYYY-MM-DD' }` | the game date is on or after that day |
| `{ fired: id }` | event id has fired |
| `{ daysSince: [id, n] }` | event id fired at least n days ago (false before it fires) |
| `{ chance: n }` | a daily roll on `state.rng` succeeds n times in 1000; evaluate it last, only when the rest of an `all` holds |

Effects (one key per object):

| Effect | Does |
| --- | --- |
| `{ declareWar: [A, B] }` | A declares war on B; only these two are at war (allies join through their own events or AI) |
| `{ peace: [A, B] }` | ends the war between A and B |
| `{ ally: [A, B] }` | makes A and B allies |
| `{ joinBloc: [A, bloc] }` | sets A's bloc (`entente`, `central` or null); joining ends A's alliances with nations at war with a member of the bloc (A broke them), and joining the bloc A is in does nothing |
| `{ mobilise: A }` | sets A's mobilisation to full; its readiness then rises day by day (`mob.days`) |
| `{ collapse: A }` | A makes peace with every enemy, its bloc becomes null, and each province A owns that an enemy controls passes to that controller |
| `{ log: key }` | adds `{ hour, kind: 'event', key }` to the log; the screens translate the key |

## 5. State (dynamic) and the public API of `sim/`

`state` is plain data that `JSON.stringify` saves (typed arrays are written as arrays by `save.js`). The map and scenario are not in it; code takes `ctx = { map, scenario, rules, state }`, where `rules` is `data/units.json` (section 6, which also holds the tuning tables).

```js
state = { v: 1, seed, rng: [a, b, c, d], hour: 0, player: 3 /* nation index */,
  doy0: 178, year0: 1914,                              // day of year and year of hour 0, from scenario.start
  next: { div, army, battle, plan, batch },            // the next id of each kind; ids are never reused
  prov: { owner: Int16Array, ctrl: Int16Array, mil: Uint8Array, civ: Uint8Array, infra: Uint8Array, supply: Int16Array, weather: Uint8Array, works: Int16Array },   // index = province id; -1 = nobody; weather indexes rules.weather;
        // works = the trench works its controller has dug there (movement.js; a save without it reads as none)
  nations: [{ tag, alive, bloc, manpower, fatigue, mobilisation, stock: { rifles, guns, heavy, mgs, shells, horses, tanks, planes },
              ready,                                                    // 0..1000 readiness: the weight its divisions fight and threaten with (diplomacy.js; a save without it reads as 1000)
              navy,                                                     // whole number of naval strength (naval.js)
              casualties,                                               // men lost, never decreases (units.lose)
              blockade,                                                 // 0..1000, share of its sea lanes cut (naval.js)
              suff: { coal, iron, oil },                                // 0..1000 resource sufficiency of its lines (industry.js)
              unlocked: [branch],                                       // locked branches it may use (rules.unlocks)
              lines: [{ item, factories, eff, prog }],                       // eff 0..1000; prog = points toward the next unit
              templates: [{ id, name, line: [branch], support: [branch] }],
              armies: [{ id, name, general, divs: [ids], front: [provinceIds] | null, offensives: [{ id, path: [provinceIds], on }] }],
              training: [{ id, tpl, count, at, done /* hour */ }], builds: [{ what, prov, prog }], ai: { ... } }],
  divs: [{ id, nation, tpl, army, prov, str, org, dig, sup, to, eta, path: [], manual }],
        // ascending id; str, org, sup 0..1000; dig = trench level * 100; to = the province being entered (null = still),
        // eta = hours left, path = the provinces after `to`; a dead division is removed. A division whose prov is a
        // sea zone (map.provinces[prov].sea) is at sea: never attacked, always moving, cannot halt
  sea: { ctrl: Int16Array },                           // index = province id; per sea zone its controller: a nation, -1 nobody, -2 contested
  battles: [{ id, prov, side /* attacking nation */, from: [provinceIds], att: [divIds], def: [divIds], hours, odds /* the last hour's p, permille */, line: [divIds] }],
        // att and def are the divisions engaged that hour (the battle width, combat.js); more may wait behind
        // line: the defending line in id order, at most combat.LINE (6); only its members defend, a broken member
        // keeps its place, and when none of them can fight the other defenders retreat (combat.js)
  rel: { 'DEU|FRA': { war, ally, access, truce, since, broke, brokeBy } },   // key = the two tags sorted; a missing pair is at peace
  memory: [[{ hour, about, kind, value }]],            // per nation, section 5.2 of the plan
  fired: ['july-crisis'], firedAt: [hour],             // events fired and the hour each last fired
  offers: [{ id, from, to, action, terms, hour, expires }], diplo: { nextOffer, lastWar, warSeen, outcome },
  settings: { difficulty: 'easy' | 'normal' | 'hard', aiBonus },
  log: [{ hour, kind: 'battle' | 'taken' | 'destroyed' | 'surrendered' | 'sunk' | 'turned-back' | 'unlocked' | 'war' | 'peace' | ..., ... }] }   // log keeps rules.logCap entries
// Every field above exists from hour 0 (state.create), nation.dip (diplomacy.js) and nation.ai too; save.read adds
// the diplomacy tables to a save written before they were made up front. nation.ai holds what the AI layers keep:
// strategy, goals, decisions (explain.js), legs and landing (general.js), ops { plans, rest, exp } (operations.js;
// a plan with push is a set piece and push its shell reserve, dug 1 or 0 whether its target was dug in when planned,
// which sets the rest after it; a save without them has none),
// main, quiet, offered, fought (nation.js). The nation AI adds templates of its own as the war goes on (doctrine: ids
// '<first template id>-w<step>[t][a]'); decisions may carry the labels 'template' and (general.js) 'raid', with the
// factors 'war-days' and 'quiet-days'.
```

Public API (everything else in `sim/` is internal and may change):

| Call | Does |
| --- | --- |
| `Conquest.state.create(map, scenario, rules, { seed, player })` | a new `state` at hour 0, weather, sea control and supply already computed |
| `Conquest.tick.step(ctx, hours)` | advances; returns `{ provinces: [ids whose ctrl changed, ascending], divs: true|false, battles: true|false, sea: true|false (state.sea.ctrl changed), events: [...] }` |
| `Conquest.tick.addSystem({ name, every, at, run(ctx, w, out) }, { after })` | adds a system to the hour (events.js, diplomacy.js); it runs when hour % every === at; what it pushes to `out.events` is what `step` returns |
| `Conquest.tick.addLayer({ name, every, at, player, run(ctx, nation) })` | adds an AI layer, run after the systems for each living nation (the player's only with `player: true`); a nation without a layer holds |
| `Conquest.orders.legal(ctx, nation, order)` | `{ ok: true }` or `{ ok: false, reason }`; a reason is a short English key the screens translate |
| `Conquest.orders.apply(ctx, nation, order)` | the same answer (with `id` for offensive and train), and applies it when ok. Players and the AI both go through this and nothing else changes state between ticks |
| `Conquest.orders.define(type, { check, run })` | adds or replaces an order type (diplomacy.js replaces `diplo`) |
| `Conquest.hash.hash(state)` | 8 hex digits |
| `Conquest.save.write(state)` / `read(text)` | to JSON text `{ format: 'nano-conquest-save', v, state }`; back as `{ ok: true, state }` or `{ ok: false, reason }` (`not-json`, `not-a-save`, `newer-version`, `bad-state`) |
| `Conquest.mapgen.generate({ seed, provinces, nations, divisions, islands })` | `{ map, scenario }` in the shapes above, 8 to 5000 land provinces; `islands` colonies with ports, garrisons and some straits |
| `Conquest.units.stats(rules, template)` | a division's derived numbers (section 6) |
| `Conquest.combat.attackPower(ctx, div, prov, defCounts, shellF = 1000)` / `defencePower(ctx, div, prov, siege)` | what a division brings to a battle, for the screens |
| `Conquest.movement.search(ctx, rel, div, goal, { open, own })` / `path(ctx, rel, div, to)` | the path search: `{ path, why: 'ok' \| 'none' \| 'sea' \| 'cap' }` (`own`: only the camp's land, open sea and the goal) / the path or null; `atSea(ctx, div)`, `canStep(ctx, rel, nation, from, to)` |
| `Conquest.mapdata.relations(state)` / `writeRel(state, tagA, tagB, patch)` / `touchRelations(state)` | the war, ally, access matrix and `belligerent[nation]`, cached per hour / the one writer of `state.rel` (merges the patch, drops the cache) / drops the cache |
| `Conquest.naval.denied(state, rel, nation, zone)` | the zone's controller is at war with the nation |
| `Conquest.naval.landing(ctx, rel, nation, zone)` | the nation may land from the zone on land an enemy holds: its camp controls the zone and projects there `naval.landMargin` times the enemies' navies |
| `Conquest.diplomacy.fits(ctx, nation, province)` | the province may pass to the nation in a peace or a capitulation (any nation: its cores and goals; a great power also land within 8 land provinces of its 1914 land and colonial land, a core of no nation; another nation land within 3) |
| `Conquest.industry.output(ctx, nation, 'mil' \| 'civ')` | effective factories (non-core provinces at `occupied.factories`); `factories(state, nation, kind)` stays the raw sum |
| `Conquest.ai.nation.think(ctx, nation)` and friends | registered with `tick.addLayer`; they only call `orders.apply` |
| `Conquest.ai.explain.recent(ctx, nation)` | the decisions to show: `[{ hour, layer, chosen, options: [{ label, score }], factors: [{ label, delta }] }]` |

Each hour runs, in order (`tick.ORDER`): weather, sea control (sinking and blockade too), supply, industry, diplomacy and events (daily, at hour % 24 = 0), the world index, movement, combat, upkeep (org regained or lost by supply, attrition), entrench, cleanup (dead divisions removed), then the AI layers: nation, operations (daily: fronts, where a colonial border is a front when a hostile division stands across it or when it faces land a hostile nation holds as its core or holds of the nation's own, `facesHome`; offensives; and set pieces against the best line, dug in or not, once no offensive meets its odds, followed by a rest of 75 days, or 21 after one against a line not dug in), general (every 6 hours, at hour % 6 = 1). The rules of each are in the header of its module: movement.js (sea voyages, straits, landings, the path search, railways behind the line, trench works and the dig cap), combat.js (with the battle formula, landings and shells), supply.js (overseas lanes), naval.js (sea control, blockade), weather.js, industry.js (resources, imports, non-core yield, recruits, unlocks), diplomacy.js (fatigue, mobilisation and readiness, capitulation and where land goes, collapse, peace; a nation whose land would pass where `fits` does not allow collapses instead of capitulating). Every loss of strength goes through `units.lose`, which adds the men (template manpower × strength / 1000, truncated per loss) to `nation.casualties`.

Orders: `{ type: 'move', div, to, by, own }` (`own: true` paths only over the camp's land, open sea and `to`; `no-path` when there is no such way, `bad-order` when `own` is not a boolean; `mil.send` falls back to it when no waypoint of the inside route is safe), `{ type: 'halt', div, by }`, `{ type: 'front', army, provinces }`, `{ type: 'offensive', army, path }` (and `{ type: 'offensive', army, offensive, path: null }` to remove one), `{ type: 'launch', army, offensive, on }`, `{ type: 'army', name, general }` (a new army, answers `id`) and `{ type: 'army', army, disband: true }`, `{ type: 'assign', div, army }`, `{ type: 'template', template }`, `{ type: 'train', template, count, at }`, `{ type: 'line', item, factories }`, `{ type: 'build', what, province }`, `{ type: 'diplo', action, to, terms }`. `orders.js` documents each one's fields and reasons; the sea and unlocks add `sea-lane-closed`, `too-far` (move), `at-sea` (halt), `support-only` (template), `locked-item` (line); `army` adds `bad-name`, `no-such-general`, `general-busy`. A move or halt marks the division `manual` (the player's own) unless `by: 'general'`, which the general AI sends. A line cut is always legal; only a raise is held to the factories. `front`, `offensive` and `launch` only record the plan; the general AI carries it out.

The worker's messages are in section 7 ("Worker protocol").

## 6. Units

`data/units.json` is the rules object: `branches` (an array: `inf cav art heavy mg eng` at the start, `tank air` with `locked: true` until a nation unlocks them), each with `attack breakthrough defence org speed supply siege river dig manpower equip` and optionally `shells` (fired per battalion per hour of attack) and `supportOnly` (`air`: support companies only, no air units on the map; its numbers add to its division like any support company's, as reconnaissance and spotting); `counters[defendingBranch][attackingBranch]`, the permille a defending battalion takes off that branch's attack (capped by `combat.counterCap`); `items` with their production `cost`, the coal, iron and oil each factory `needs` a day, and `unlock` (the branch that must be unlocked first); `resources.perLevel` (units of a resource per province level); `occupied` (permille of factories and recruits a non-core province yields); `recruit.perProvince` (men a core province adds a day); `unlocks` (`[{ branch, from, mil }]`: the day and the effective military factories that unlock a branch); `naval` (voyage hours, `falloff` of projected navy per zone hop, control `margin`, default navies, landing factors, sea supply loss and port capacity); the `terrain`, `weather` and `climates` tables; `generals` (what each trait changes); and the tuning of combat (`noShells`; `width` and `widthFlank`, the divisions of each side a battle engages each hour; `dig`, the defence per trench level, against the mean siege of the engaged attackers), dig (`perHour`, `engineers`, `max`, and the cap a nation can dig to: `base` + `perWarDay` × the days of its oldest war), move (`searchCap`; `infra` speeds a step into land the enemy held, `rail` a step between provinces of one camp), naval (`landMargin`, the share of navy over the enemies' a landing needs), supply, industry, `recruit.perProvince` (men a core province adds a day; the draft of diplomacy.js carries the size of a nation), train, reinforce and build.

A division's stats are derived from its template and never stored (`units.js`): a line battalion counts 1000, a support company `template.support`; attack, defence, supply, siege and the rest are the sums; org is the mean org of the line; speed is the slowest branch.

## 7. The page side: `Conquest.game` and the screens

The page never holds the simulation. `ui/game.js` owns the worker and keeps a mirror that every screen reads; nothing else posts to the worker. `index.js` loads `view/` and then the files of `ui/modules.json` in order (through `conquest:uiModules`); once the workspace is open it mounts the shell and shows the start screen.

```js
Conquest.game = {
  map, scenario, rules, idSource, source,     // as loaded; source 'world-1914' | 'generated'
  status,                                     // 'none' | 'starting' | 'running' | 'crashed'; running is status === 'running'
  player, hour, speed, meta,                  // nation index; hours since the start; 0 = paused, 1..5; the save meta
  date(hour?) -> { y, m, d, h },              // from scenario.start
  nationName(i),                              // the scenario's name through tr()
  prov: { owner: Int16Array, ctrl: Int16Array },
  supply: Int16Array, weather: Uint8Array,    // per province, refreshed once a game day
  divs: Map<id, { id, nation, prov, to, str, org, army, sup, dig, manual, eta, dest, tpl }>,   // to, dest -1 when still; army null
  battles: [...], sea: Int16Array,            // sea: per sea zone its controller (-1 nobody, -2 contested)
  nations: [{ index, tag, name, color, alive, bloc, manpower, fatigue, mobilisation, ready, stock, casualties, blockade, navy, suff, unlocked,
              war, ally, access }],           // war, ally, access: towards the player
  me,                                         // the player's nation object, whole, once a game day and after each order
  factories: { mil, civ },                    // industry.output of the player, with me
  offers, log, outcome,                       // offers that involve the player; the last 500 log entries; null until the end
  selection: { province, army, division, divisions },   // setSelection(patch) merges and emits 'select'
  order(order) -> Promise<{ ok, reason, id, provinces }>,  // as the player; the mirror holds the change when it resolves
  query(what, args) -> Promise<value>,        // rejects with Error(reason)
  setSpeed(n), togglePause(),
  save(name) -> Promise<{ ok, code? }>, load(name) -> Promise<{ ok, reason? }>, list(),
  newGame({ scenario: 'world' | 'generated', gen?, player, seed, difficulty, data? }) -> Promise<{ ok, reason? }>,
  generate(gen) -> Promise<{ map, scenario }>, loadWorld(), close(), reloadLast(), AUTOSAVE: 'Autosave',
  autosaveName, autosave(), isAutosave(name),  // this game's autosave, "Autosave <game>" (below)
  on(event, fn) -> off,
  debug: { worker, fault(), pending, setState(set) },   // tests
}
```

Events: `tick` (at most once an animation frame, and four times a second in a hidden window, with what changed since the last one: `{ provinces: Set, divs, battles, sea, day, supply, me, nations, log, events }`), `day` (a game day began: its daily systems have run, at its hour 1), `event` (each new log entry and each tick event), `offers`, `over` (the outcome), `speed`, `select`, `ordered` ({ order, result }), `loaded` ({ save }), `saved` ({ name, auto }), `closed` (back to the start screen), `crashed` ({ message }).

Worker protocol (`sim/host.js`). In: `init { map, scenario, rules, seed, player, settings, meta }` or `init { map, scenario, rules, save, meta }`, `generate { id, opts }` (opts.war puts every pair of nations at war), `order { id, order }`, `speed { n }`, `save { id, meta }`, `query { id, what, args }`, `explain { id, nation }`, `fault {}` (the next batch throws). Out: `ready { id, snapshot, meta, divFields, delta }`, `generated { id, map, scenario }`, `tick` (a delta), `orderResult { id, ok, reason, value, delta }`, `saved { id, text }`, `answer { id, ok, value, reason }`, `explained`, `error { id?, reason, message? }` (reason `tick-failed` stops the game). The whole state crosses only in `ready`; a delta is `{ hour, day, provinces: [[id, owner, ctrl]] (changed since the last delta), divs: Int32Array (divFields per division, transferred) | null, tpls: [[id, template]] (divisions not sent before), battles | null, nations: [row], me | null, factories | null, offers | null, log: [new entries; a battle's carries side and defender], outcome | null, sea | null, supply | null, weather | null, events }`. A batch is tick.step one hour at a time. A save is save.write's text with the meta as its first field, `{"meta":{ scenario, gen, seed, difficulty, tag, nation, hour, date: [y, m, d] },"format":...}`, which `conquest:list` and `conquest:load` read back without parsing the state.

Queries (`sim/queries.js`; each is a pure read of the state; `nation` defaults to the player): `province { id }` (name, terrain, climate, weather, supply, infra, mil, civ, hub, coal, iron, oil, owner, ctrl, cores, coastal, port, sea, `works` and `dug` (movement.dugIn; null at sea), `trench` (movement.TRENCH, 300), the divisions there, the battle there with its `line` (a copy) and `lineMax` (combat.LINE)), `division { id }` (with path, eta, dest, stats, `template { line, support }`, its army's `general` and `trait`, and `battle`: the province of a battle it stands in or enters), `battle { prov }` (below), `army { id, nation }`, `legal { order }`, `stats { template }`, `route { div, to }` (`{ path, why, hours }`), `explain { nation }`, `memory { nation }`, `relations { nation }`, `evaluate { to, action, terms }`, `outcome {}`, `plans { nation }` (fronts and offensives; another nation's only once the game is over), `hash {}`.

`battle { prov }` answers why a battle's odds are what they are, from the code path the battle used. Each hour `combat.fight` keeps what it was fought with beside the state (`combat.lastHour(b)`, a WeakMap keyed by the battle object, so neither the hash nor a save sees it): the engaged divisions' nation, template, army, province, strength, supply and trenches, each attacker's shell factor, the siege, the flank factor, the width and the directions, and who waited behind or stood outside the line. `attackPower` and `defencePower` take an optional list `rec` onto which they push every multiply in the order applied (`['base', v]` first, then `[factor, permille, raw?]`); with no list they compute exactly what they did before. The query runs them again on that hour's values and returns `{ id, prov, side, defender, hours, odds, from, terrain, weather, works, dug, trench, line, lineMax, att, def, hour, factors }`: `att` and `def` are div rows of the divisions now entering and standing in the province with their `role` (`engaged` that hour, `waiting`, `outside` the line, `broken`); `hour` is `{ hour, A, D, flank, siege, width, dirs, odds, att: [{ id, shellF, power, steps }], def: [{ id, power, steps }] }`, where folding each division's steps, summing, and multiplying the attackers' sum by `flank` gives back `b.odds` exactly; `factors` is `{ att, def }`, each `[{ key, effect }]` sorted by size, `effect` the signed permille the side's total gains from the factor (its total against its total without it; `general` also removes its terrain relief, `siege` compares the works with the siege against the works without it, `counters` and `shells` re-run `units.attackVs` without the defenders' counts or with full shells). `hour` and `factors` are null until the battle has fought an hour since the game was loaded; a province with no battle answers `no-battle`.

A screen is a panel registered with `Conquest.ui.panel({ id, title, icon, order, mount(el, game) -> { update(), destroy() } })`: a button with its glyph and title at the left of the top bar (`icon` is an `ide.icon` name; lower `order` first; its key comes from the shell's `PANEL_KEYS` table and is registered as the action `Conquest.Panel.<id>`). One panel is open at a time, docked at the left of the map. The shell mounts a panel the first time it opens and keeps it; it calls `update()` on the open panel when it opens, once a game day and after each of the player's orders; it calls `destroy()` when the game ends. The open panel is remembered (`conquest.panel`). A panel builds its form once and redraws only its lists (development.md, renderer rules), reads `Conquest.game`, and changes the game only through `game.order`. To add one: put its script in `ui/` and its name in `ui/modules.json` after `shell.js`, and its strings in `locales/ko.json` (`verify/conquest-game.mjs` checks every `tr()` literal under `ui/`). Shared helpers: `Conquest.ui.text` (the translation tables: `reason`, `log`, `event`, `alert`, `terrain`, `weather`, `climate`, `trait`, `bloc`, `branch`, `action`, `difficulty`, `nation`, `date`, `number`, `percent`; an unknown key reads as words), `Conquest.ui.shell` (`view`, `bind`, `stage`, `toast(text, at)`, `alert(kind, text, prov, group?)`, `setMode`, `alertCounts()` (per kind the alerts kept under its badge), `openAlerts(kind | null)`, `takenKind(prov, before, by)` ('taken', 'lost' or null: an enemy taking the province from the player, or the player's own land from an ally, is 'lost'), `setLegend(on)`, `overlayOpen()`, `TOAST_MS`), `Conquest.ui.events` (`on/emit` of `game` when a game is shown and `start` when the start screen is), `Conquest.ui.sideOf(game, nation)`.

Files: `ui/text.js` (the tables), `ui/game.js` (`Conquest.game`), `ui/mapbind.js` (the map from the mirror: colours, sea tint, nation names, counters per province and side, battle markers, the war front and the armies' fronts, plans, tooltip), `ui/shell.js` (layout; the top bar with the panel buttons, the resource chips and their tooltips (the mirror and the `economy` query) and the time control; the dock at the left of the map; alerts as toasts that leave by themselves (war and offers stay) and badges per kind, with pause-on-alert in `conquest.pauseOn`; the paused flag; map modes and the legend toggle (`conquest.legend`); crash notice; the keys Space, +, -, 1..5, Q W E R T for the panels, F1..F5 for the map modes, L for the legend, Escape), `ui/command.js` (the province card, the army bar, drawing fronts and offensives, the route preview and the right-click move), `ui/selectbox.js` (box selection, the double click, the arrow keys), `ui/selpanel.js` (the selection panel), `ui/minimap.js` (the minimap), `ui/battle.js` (the battle window and the division detail), `ui/tip.js` (the shared explaining tooltip), `ui/start.js` (the start screen). `view/raster.js` draws a generated map's id image. The map's zoom keys are PageUp and PageDown.

The map view (`Conquest.view.create`, header of `view/view.js`) adds for the screens: `setNames(names, capitals, homes?)` (per nation its shown name, capital and home provinces, `Conquest.ui.homesOf(scenario)`: its cores, or its 1914 land when the scenario lists none; `view/labels.js` places a Label `{ nation, text, x, y, angle, size, spacing, main }` on the connected area holding most of its home land (the capital's on a tie) and up to two more on large other areas, again whenever control changes, and fades them out zoomed in), `setBorderLines([{ pairs: [[a, b]], color, width, army? }])` (drawn along the real edges, `view/borders.js`: `edge(a, b)` is an Edge, polylines of pixel-grid vertices that each touch a pixel of both provinces, derived from the id raster once per pair), `setMarkers([{ prov, odds, mine }])` (battle markers; `markerAt(sx, sy)`, and a click on one selects its province with `marker: true` on the select event), `counters()` (the Clusters drawn at this zoom, `view/units.js`: a unit with a `key` merges with same-key units of neighbouring provinces whose boxes would overlap; the zoom bucket alone decides) and the getters `labels`, `labelAlpha`, `borderLines`, `markers`. A unit also takes `org` (the organisation bar above the strength bar) and `selected`. `ui/mapbind.js` exposes `warPairs` (camp land next to land an enemy controls), `armyPairs` (per army, the pairs of its front) and `counterAt(sx, sy)`, which answers a merged counter's largest stack and in `all` the groups it merges (a click selects all of them); its map tooltip names a battle marker (summary and "click for details") or a counter (nation, divisions, mean strength and organisation, armies, and for a merged counter how many stacks in how many provinces) under the pointer, hit-tested only on pointer moves and at most every 60 ms; `Conquest.ui.armyColor(id)` is an army's colour on the map and in the army bar. No data was added to the delta or the queries: the battles' `odds`, `prov.ctrl` and `me.armies[].front` were already mirrored.

The battle window, the division detail and the shared tooltip (`ui/battle.js`, `ui/tip.js`):

- `Conquest.ui.battle`: `open(prov)` (one window at a time, a non-modal `role="dialog"` labelled by its title, placed beside the province on the side with more room), `close()`, `prov` (0 when closed), `data` (the last `battle` answer), `ended` (the battle's log entry once it is over). It asks again when the mirror's battle there has a new `hours`, and keeps its last answer with the ending once the log entry arrives. A click on a marker (`select` with `marker: true`) and on the province card's Battle fact opens it.
- `Conquest.ui.divDetail`: `show(id, host)` draws the `division` query (and for the player's own a `route` to its destination for the hours) into `host`, the province card's or the battle window's detail box; `close(host?)`, `id`.
- `Conquest.ui.shell.overlays`: `[{ open(), close() }]`; `Conquest.Escape` closes an alert list or the pause settings first, then the first open overlay (the division detail, then the battle window), then the panel. `shell.overlayOpen()` counts them, so Clear the Selection waits for them.
- `Conquest.ui.tip`: `show(anchor, { title, rows: [[key, label, text, raw]], note, key })`, `hide(anchor?)`, `attach(node, build, { focus, hover })`, `anchor`; one fixed-position element `#cq-stat-tip` (`data-stat` is the key, each row `data-k` and `data-v`) for the resource chips, the card's Supply, Infrastructure and Trenches facts (their note also in `data-note`) and the army cards' str, org and sup.
- `Conquest.ui.text` adds `combat(key)` (the factor labels), `role(key)` and `COMBAT_KEYS`, and `oncePerEvent(entries)`: a fired event logs { kind: 'fired', id } and { kind: 'event', key } in the same hour, and a list keeps only the second (the end screen's timeline, the Event Log).
- `Conquest.ui.shell.alert(kind, text, prov, group, { quiet })` returns the alert; a quiet one is counted under its badge with no toast and no pause (an offer the player already refused or let lapse: `shell.offerRepeats(offer)` > 0, keyed by nation, kind and terms). `shell.offerGone()` lists the incoming offers that left the list unanswered ({ offer, reason: 'expired' | 'overtaken', hour }); `dismissGoneOffer(id)`, `dropOfferToast(id)`; `ui.events` 'offers-changed' tells the diplomacy panel to redraw its inbox. `shell.fitBadges()` makes the badge row compact (marks and counts) when a name would be cut.
- `Conquest.ui.endgame.verdict(outcome)` -> { result: 'won' | 'lost' | 'none', text }.

Commanding with the mouse (`view/camera.js`, `ui/selectbox.js`, `ui/selpanel.js`, `ui/minimap.js`, `ui/command.js`):

- `view/camera.js` splits a left drag in this order: the painter (`view.setPainter`, drawing a plan) when its `down` accepts, else the box `view.setBox(fn)` answers (`{ start, move, end(sx, sy, shift), cancel }`; `ui/selectbox.js` gives one unless `conquest.leftDrag` is `'pan'`), else a pan. A right or middle drag always pans; a right press and release that did not move is the `context` event. The view adds `dblselect` events, `shift` on `select`, `pan(dx, dy)` (the arrow keys) and `idAt(mx, my)` (the province at a texture point, for the minimap).
- Selection is still `game.selection`: a box, a Shift click or box (adding), a double click on an own counter (that army's stacks on screen) and a click on a merged counter (all its own stacks) set `divisions`, and `army` to the army most of them belong to.
- `Conquest.ui.selPanel` (`render`, `element`) lists the selection by army and acts on it through `halt` and `assign` (and `army` then `assign` for New Army from Selection); a button the `legal` query refuses for every selected division is disabled with the reason (`data-reason`). `Conquest.ui.minimap` (`painted`, `size`, `element`); `Conquest.ui.corner()` is the bottom-left column both live in; `Conquest.ui.command` adds `fitCard`, `askArmyName(onCreated)`, `flash(prov, text)` (`.cq-flash`), `stepArmy(dir)`, `centreArmy(id)` and `send(order)`.
- The route preview (`.cq-route-tag`, `data-ok`, `data-hours`, `data-prov`) asks `route` for one division in each of up to six of the selection's provinces, 90 ms after the pointer settles on a province; the plan preview passes `setPreview({ pairs })` to `ui/mapbind.js`, a border line with `preview: true`; the plan hint is `.cq-plan-hint` (`data-kind`, `data-odds`).
- One query was added, read-only: `attackOdds { army, prov }` -> `{ odds, attackers, defenders }`, `ai/mil-common.js` `odds()` for the player's army's divisions its general may move that stand next to `prov` (header of `sim/queries.js`). The orders have no waypoints or queued moves, so Shift+right-click is a plain move; no order type was added.
- Korean particles: `Conquest.ui.text.tr` (the `tr` of every `ui/` file) resolves the markers `{이/가}`, `{을/를}`, `{은/는}`, `{과/와}` and `{으로/로}` that a Korean string writes after a placeholder, from the inserted name's final consonant (`particles(s)`); a name not ending in Hangul gets the double form.

Diplomacy, the judgment panel and the end of the game (`ui/dip-ui.js`, `ui/panel-diplomacy.js`, `ui/panel-judgment.js`, `ui/endgame.js`):

- Their queries: `memory { nation, summary: true }` adds `{ trust: [per nation], grudge: [per nation], about: ai.memory.summary }` (without `summary` it is the raw ledger); `nation { nation }` (bloc, major, capital, fatigue, mobilisation, mobTarget, weak, personality, goals with base and current weight, held and progress); `calls { to }` (whom the player's declaration of war on `to` calls to arms on each side, and whether it is a betrayal); `peace { to, provinces }` (the provinces each side holds of the other's and any listed ones, with `diplomacy.pts` for both). `explain { nation }` and the worker's `explain` message answer another nation's `operations` and `general` decisions only once the game is over (plan 5.5), the same rule as `plans`.
- The worker pauses itself once, on the hour the outcome appears; after that `speed` runs it on (the end screen's Keep Watching).
- `Conquest.ui.dip`: `selected` (the nation both panels look at; `select(n)` emits `dip-select` on `Conquest.ui.events`), `focusProvince(id)`, `openPanel(id)`, `partsEl(parts)` (text with clickable provinces), `meter('trust' | 'grudge')`, `vlist(cls, rowHeight, render)` (a list that keeps only its visible rows), `mainEnemy()`. The shell's `open-offer` event (an offer alert's click) opens the diplomacy panel; waiting offers set `--cq-dip-offers` and `cq-dip-has-offers` on `.cq-app`, which draw the count on the tab.
- `Conquest.ui.text` adds `decision(label, args, nation, mark)` and `factor(...)` (sim/ai/explain.js labels; with `mark` the result is parts whose provinces and nations a screen can link), `memory(kind, about)`, `reply(key, { nation, because })` (diplomacy.evaluate's reply keys), `goal(goal, nation)`, `personality(p)`, `layer`, `outcome`, `score` and `signed` (1000 = 1.00), and `KEYS` (every label they translate).
- `ui.endgame`: `show()`, `shown`.
- `conquest:wording` (main) takes `{ nation, year, decision, factors: [words], canned, language }` and answers `{ ok, text }` or `{ ok: false, code }` (`invalid`, `timeout`, `empty`, main/ai/claude.js's codes). The page asks only with the setting `conquest.llmReplies` on (off by default) and only for a reply the player is shown; the decision is the simulation's. Tests point `PYIDE_CLAUDE_PATH` at a stand-in and shorten the wait with `PYIDE_CONQUEST_WORDING_MS`.

Economy, army building, the staff, the guide and settings (`ui/eco-common.js`, `ui/eco-pick.js`, `ui/eco-staff.js`, `ui/eco-train.js`, `ui/panel-production.js`, `ui/panel-designer.js`, `ui/guide.js`, `ui/settings.js`):

- Time. The five speeds are fixed rates (`sim/host.js` `SPEED`): 1 = 2 game hours a second, 2 = 6, 3 = 24 (a day a second), 4 = 72, 5 = as fast as the machine goes. Every 50 ms the host runs the whole hours owed at the rate, spending at most 40 ms; hours a slow frame could not run are dropped, so the game slows down instead of building a backlog. Speed 5 runs 6-hour chunks until 40 ms are spent, then posts. The speed buttons' tooltips say the rate.
- A game day is reported when its daily systems have run: the host's `day` flag and the page's `day` event come at hour 1 of each day (the systems run in the step from hour 0), so `me`, supply and weather sent with it are the new day's.
- Their queries: `economy { nation }` (factories in use and free, each line with factories, efficiency, output a day in tenths, the sufficiency of its scarcest resource and what it lacks, the items with their locks and unlock conditions, stock, output and reinforcement need a day per item, coal, iron and oil with own, imported, blockade and sufficiency, manpower with recruits, draft, men in training and losses, the build queue with days left, the training queue with hours to the daily run that forms it, and per template how many divisions use it, its manpower and equipment and how many the stock equips now; `fatigue`: the nation's war fatigue with diplomacy.js's capitulation and collapse thresholds and the collapse chance's base and slope, read-only, for the top bar); `buildable { what }` (the provinces where a build is legal now, their levels, its cost, the build points a day and the points queued before it); `suggestFronts { nation, armies? }` (`[{ army, provinces, kind: 'front' | 'reserve', against }]`: the fronts `ai.operations.fronts` gives those armies that have divisions, the same path the operations AI takes for an AI nation (its contact line with the shared line beside allies, colonies facing an enemy's home, the capital guard and the expedition), run on a copy of the nation's expedition memory so nothing changes; provinces in chain order; an army with no division, and every army when there is no contact line, holds the capital and the land next to it as a reserve).
- Tests: `init { test: true }` (only when `conquest:testHooks` answers `on`, which is `PYIDE_CONQUEST_TEST=1`) allows the message `test { id, set: [{ path, value }] }`, which writes values into the state and answers `testDone { id, delta }`; `Conquest.game.debug.setState(set)` sends it.
- `Conquest.game` adds `autosaveName` (`"Autosave <game>"`, the meta's `game` id given at a new game), `autosave()` (that save, unless `conquest.autosave` is off: then `{ ok: false, code: 'off' }`) and `isAutosave(name)`; `save(AUTOSAVE)` writes this game's autosave. `date(hour)` counts the simulation's calendar (`sim/weather.js`: 365-day years, no 29 February), so every date on screen is the one the simulation's dated conditions and the 1 January 1920 end use. The meta also carries `aiBonus` (from `conquest.aiBonus` at a new game, passed to the worker as `settings.aiBonus`), `staff` (`{ auto, reserve, hand }` army ids) and `trainTo` (per training batch, the army its divisions join). main keeps the newest five `Autosave*` files after each autosave. Continue loads the newest autosave.
- `Conquest.ui.shell` adds `openPanel(id)` (null closes) and `panelOpen`; the top bar has Help (emits `help` on `Conquest.ui.events`) and a gear that opens the Settings window on the `conquest` page; `conquest.pauseOn` is read again whenever it changes. Alerts add the kind `staff`. `Conquest.ui.command` adds `revealDivision(id)` (the card's division list is virtualised) and `renderArmies()`; the army bar adds Staff Front and Replan All Fronts.
- `Conquest.ui.staff`: `assign(armyIds, { force })`, `replanAll()`, `check()`, `isStaff(id)`, `isReserve(id)`, `isHand(id)`; it emits `staffed` ({ armies, force }) on `Conquest.ui.events`. A `front` order not sent by the staff marks that army as the player's (`hand`), which the staff leaves alone unless asked with force.
- `Conquest.ui.train.form(root)` (the training form both panels use), `Conquest.ui.pick.start({ title, legal, describe, onPick })` (picking a province on the map), `Conquest.ui.eco` (branch symbols, the stepper, formatting, `statsOf`), `Conquest.ui.guide` (`show()`, `close()`, `step`, `steps`).
- Settings keys: `conquest.legend` (false, whether the legend is open), `conquest.aiBonus` (false), `conquest.staffFronts` (true), `conquest.autosave` (true), `conquest.guideDone` (false), with `conquest.pauseOn` and `conquest.panel`. The Settings page (`ide.settingsPages`, id `conquest`, `craft: true`) shows them; another screen adds a section to it with `Conquest.ui.settingsRows.push({ id, title, mount(section, ctx) })`. `conquest.llmReplies` (false) is set by the diplomacy panel's Word Replies with Claude box, not on that page.
- Panel ids: `production` (order 200), `designer` (210), `diplomacy` (300), `judgment` (310), `log` (900, the event log in `ui/shell.js`).
