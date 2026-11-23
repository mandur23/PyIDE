// Conquest.ui.text: the words for the simulation's keys. Refusal reasons (sim/orders.js, sim/diplomacy.js, save.js,
// the IPC codes), log entries, alert kinds, terrain, weather, climates, traits, blocs, the 1914 events, equipment items,
// buildings and resources each have a table of English strings that tr() translates; a key missing from its table
// reads as itself in words ("no-such-x" -> "No such x"), so a key the simulation adds later still shows something
// readable. Nation names are data but go through tr() too (locales/ko.json has the 58 of 1914 keyed by their English name); a generated map's names stay.
// Korean particles: a Korean string writes the particle after its placeholder as a marker, "{att}{이/가}", and
// Conquest.ui.text.tr (what the ui files call tr) picks the form from the inserted name's final consonant: 이/가, 을/를,
// 은/는, 과/와, 으로/로 (ㄹ takes 로). A name that does not end in a Hangul syllable gets the double form, 이(가).
// tr()'s substitution leaves the marker alone (it replaces only {word}), and an English string has none.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const PARTICLES = { '이/가': ['이', '가', '이(가)'], '을/를': ['을', '를', '을(를)'], '은/는': ['은', '는', '은(는)'], '과/와': ['과', '와', '과(와)'], '으로/로': ['으로', '로', '(으)로'] };
  const particles = (s) => String(s).replace(/(.?)\{(이\/가|을\/를|은\/는|과\/와|으로\/로)\}/g, (m, before, key) => {
    const [hard, soft, both] = PARTICLES[key];
    const c = before ? before.charCodeAt(0) - 0xac00 : -1;
    if (c < 0 || c > 11171) return before + both;
    const final = c % 28;
    return before + (final && !(key === '으로/로' && final === 8) ? hard : soft);
  });
  const tr = (text, vars) => particles(ide.t(text, vars));

  const words = (key) => {
    const s = String(key ?? '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  };
  const lookup = (table) => (key, args) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key](args || {}) : words(key));

  const REASONS = {
    'bad-order': () => tr('That order is not valid.'),
    'unknown-order': () => tr('The simulation does not know this order.'),
    'no-such-nation': () => tr('There is no such nation.'),
    'no-such-army': () => tr('That army no longer exists.'),
    'no-such-division': () => tr('That division no longer exists.'),
    'not-yours': () => tr('That division is not yours.'),
    'no-such-province': () => tr('There is no such province.'),
    sea: () => tr('Divisions cannot be sent to a sea zone.'),
    'already-there': () => tr('The division is already there.'),
    'no-path': () => tr('There is no way to get there.'),
    'sea-lane-closed': () => tr('The way there crosses a sea lane the enemy controls.'),
    'too-far': () => tr('That is too far to plan a route.'),
    'at-sea': () => tr('A division at sea cannot stop.'),
    'bad-province': () => tr('The plan must list land provinces.'),
    'no-such-offensive': () => tr('That offensive no longer exists.'),
    'bad-template': () => tr('The division template is not valid.'),
    'unknown-branch': () => tr('The template uses an unknown kind of unit.'),
    'locked-branch': () => tr('That kind of unit is not available yet.'),
    'support-only': () => tr('That kind of unit can only be a support company.'),
    'too-large': () => tr('The template is too large.'),
    'no-such-template': () => tr('There is no such division template.'),
    'bad-count': () => tr('The number is out of range.'),
    'no-manpower': () => tr('Not enough manpower.'),
    'no-equipment': () => tr('Not enough equipment.'),
    'unknown-item': () => tr('Unknown equipment.'),
    'locked-item': () => tr('That equipment is not available yet.'),
    'not-enough-factories': () => tr('Not enough military factories.'),
    'unknown-building': () => tr('Unknown building.'),
    'at-cap': () => tr('That province cannot take more of it.'),
    'not-implemented': () => tr('This is not available yet.'),
    self: () => tr('A nation cannot do that to itself.'),
    dead: () => tr('That nation is gone.'),
    weakened: () => tr('The nation is too weakened to declare war.'),
    'already-at-war': () => tr('Already at war.'),
    'same-bloc': () => tr('Both are in the same bloc.'),
    allied: () => tr('They are allies.'),
    truce: () => tr('A truce is still in force.'),
    'at-war': () => tr('Not while at war with them.'),
    'already-allied': () => tr('Already allied.'),
    'already-offered': () => tr('That offer is already waiting for an answer.'),
    'not-allied': () => tr('Not allied with them.'),
    'in-bloc': () => tr('Already in a bloc.'),
    'at-war-with-member': () => tr('At war with a member of that bloc.'),
    'no-bloc': () => tr('Not in a bloc.'),
    'already-access': () => tr('Military access is already granted.'),
    'not-at-war': () => tr('Not at war with them.'),
    'bad-terms': () => tr('Those terms are not valid.'),
    'no-such-offer': () => tr('That offer no longer exists.'),
    'offer-stale': () => tr('That offer no longer applies.'),
    'unknown-action': () => tr('The simulation does not know this action.'),
    'no-game': () => tr('No game is running.'),
    'no-answer': () => tr('The simulation did not answer in time.'),
    crashed: () => tr('The simulation stopped.'),
    failed: () => tr('The simulation could not do that.'),
    'not-json': () => tr('The file is not a saved game (it is not JSON).'),
    'not-a-save': () => tr('The file is not a Conquest save.'),
    'newer-version': () => tr('The save was written by a newer version of Nano Studio.'),
    'bad-state': () => tr('The save is damaged.'),
    missing: () => tr('The file is missing.'),
    unreadable: () => tr('The file could not be read.'),
    badName: () => tr('That name cannot be used for a save.'),
    badText: () => tr('The save is too large.'),
    tooBig: () => tr('The save is too large.'),
    invalid: () => tr('The game files are damaged.'),
    'bad-name': () => tr('That name cannot be used.'),
    'no-such-general': () => tr('There is no such general.'),
    'general-busy': () => tr('That general already leads an army.'),
  };

  const P = (id) => Conquest.game?.map?.provinces[id]?.name || '?';
  const N = (i) => Conquest.game?.nationName(i) || '?';
  const LOG = {
    battle: (e) => (e.won === 'att' ? tr('Battle of {province}: the attackers won', { province: P(e.prov) }) : tr('Battle of {province}: the defenders held', { province: P(e.prov) })),
    taken: (e) => tr('{nation} took {province}', { nation: N(e.by), province: P(e.prov) }),
    destroyed: (e) => tr('A division was destroyed in {province}', { province: P(e.prov) }),
    sunk: (e) => tr('A division was lost at sea in {province}', { province: P(e.prov) }),
    'turned-back': (e) => tr('A crossing to {province} was turned back', { province: P(e.prov) }),
    unlocked: (e) => tr('{nation} can now field {branch}', { nation: N(e.nation), branch: ui.text.branch(e.branch) }),
    war: (e) => tr('{a} declared war on {b}', { a: N(e.a), b: N(e.b) }),
    bloc: (e) => (e.bloc ? tr('{nation} joined the {bloc}', { nation: N(e.nation), bloc: ui.text.bloc(e.bloc) }) : tr('{nation} left its bloc', { nation: N(e.nation) })),
    peace: (e) => tr('{a} and {b} made peace', { a: N(e.a), b: N(e.b) }),
    capitulated: (e) => tr('{nation} capitulated', { nation: N(e.nation) }),
    collapsed: (e) => tr('{nation} collapsed', { nation: N(e.nation) }),
    accepted: (e) => tr('{to} accepted the offer of {from} ({action})', { to: N(e.to), from: N(e.from), action: ui.text.action(e.action) }),
    refused: (e) => tr('{to} refused the offer of {from} ({action})', { to: N(e.to), from: N(e.from), action: ui.text.action(e.action) }),
    'game-over': () => tr('The war is over'),
    event: (e) => ui.text.event(e.key),
    fired: (e) => ui.text.event(e.id),
  };

  const EVENTS = {
    sarajevo: () => tr('Archduke Franz Ferdinand is shot in Sarajevo'),
    ultimatum: () => tr('Austria-Hungary sends Serbia an ultimatum'),
    'aut-declares-srb': () => tr('Austria-Hungary declares war on Serbia'),
    'mne-joins': () => tr('Montenegro stands with Serbia'),
    'rus-mobilises': () => tr('Russia mobilises'),
    'deu-declares-rus': () => tr('Germany declares war on Russia'),
    'deu-declares-fra': () => tr('Germany declares war on France'),
    schlieffen: () => tr('Germany marches into Belgium'),
    'belgium-violated': () => tr('Belgian neutrality is violated'),
    'gbr-enters': () => tr('Britain enters the war'),
    'aut-declares-rus': () => tr('Austria-Hungary declares war on Russia'),
    'entente-declares-aut': () => tr('Britain and France declare war on Austria-Hungary'),
    'jpn-enters': () => tr('Japan enters the war'),
    'ottoman-alliance': () => tr('The Ottoman Empire signs a secret alliance with Germany'),
    'ottoman-entry': () => tr('The Ottoman Empire enters the war'),
    'italy-entente': () => tr('Italy signs the Treaty of London'),
    'ita-declares-deu': () => tr('Italy declares war on Germany'),
    'bul-entry': () => tr('Bulgaria joins the Central Powers'),
    'rou-entry': () => tr('Romania enters the war'),
    'por-entry': () => tr('Portugal enters the war'),
    'grc-entry': () => tr('Greece enters the war'),
    usw: () => tr('Germany resumes unrestricted submarine warfare'),
    'us-entry': () => tr('The United States enters the war'),
    'us-declares-aut': () => tr('The United States declares war on Austria-Hungary'),
    'february-revolution': () => tr('Revolution breaks out in Russia'),
    'russian-collapse': () => tr('Russia collapses'),
    'bul-collapse': () => tr('Bulgaria collapses'),
    'tur-collapse': () => tr('The Ottoman Empire collapses'),
    'aut-collapse': () => tr('Austria-Hungary collapses'),
    'deu-collapse': () => tr('Germany collapses'),
  };

  const ALERTS = {
    war: () => tr('War declared'),
    lost: () => tr('Province lost'),
    taken: () => tr('Province taken'),
    'battle-lost': () => tr('Battle lost'),
    'low-supply': () => tr('Low supply'),
    offer: () => tr('Offer received'),
    event: () => tr('Historical event'),
    staff: () => tr('Staff plan'),
  };

  const TERRAIN = { plains: () => tr('Plains'), forest: () => tr('Forest'), hills: () => tr('Hills'), mountain: () => tr('Mountains'), marsh: () => tr('Marsh'), desert: () => tr('Desert'), urban: () => tr('Urban') };
  const WEATHER = { clear: () => tr('Clear skies'), rain: () => tr('Rain'), mud: () => tr('Mud'), snow: () => tr('Snow'), frost: () => tr('Frost') };
  const CLIMATES = { arctic: () => tr('Arctic'), cold: () => tr('Cold'), temperate: () => tr('Temperate'), mediterranean: () => tr('Mediterranean'), arid: () => tr('Arid'), tropical: () => tr('Tropical') };
  const TRAITS = { offence: () => tr('Offensive doctrine'), defence: () => tr('Defensive doctrine'), terrain: () => tr('Terrain expert'), logistics: () => tr('Logistician') };
  const BLOCS = { entente: () => tr('Entente'), central: () => tr('Central Powers') };
  const BRANCHES = { inf: () => tr('Infantry'), cav: () => tr('Cavalry'), art: () => tr('Field Artillery'), heavy: () => tr('Heavy Artillery'), mg: () => tr('Machine Guns'), eng: () => tr('Engineers'), tank: () => tr('Tanks'), air: () => tr('Air Support') };
  const ACTIONS = { 'declare-war': () => tr('declaration of war'), 'offer-alliance': () => tr('alliance'), 'break-alliance': () => tr('end of alliance'), 'join-bloc': () => tr('joining a bloc'),
    'leave-bloc': () => tr('leaving a bloc'), 'ask-access': () => tr('military access'), 'offer-peace': () => tr('peace'), 'call-to-arms': () => tr('call to arms') };
  const DIFFICULTY = { easy: () => tr('Easy'), normal: () => tr('Normal'), hard: () => tr('Hard') };
  const ITEMS = { rifles: () => tr('Rifles'), guns: () => tr('Field guns'), heavy: () => tr('Heavy guns'), mgs: () => tr('Machine guns'), shells: () => tr('Shells'), horses: () => tr('Horses'), tanks: () => tr('Tanks'), planes: () => tr('Aircraft') };
  const BUILDINGS = { mil: () => tr('Military factory'), civ: () => tr('Civil factory'), infra: () => tr('Infrastructure') };
  const RESOURCES = { coal: () => tr('Coal'), iron: () => tr('Iron'), oil: () => tr('Oil'), locked: () => tr('Locked') };
  // The factors of a battle hour (sim/queries.js `battle`) and the roles of its divisions.
  const COMBAT = { strength: () => tr('Strength of the engaged divisions'), terrain: () => tr('Terrain'), weather: () => tr('Weather'), river: () => tr('River crossing'),
    landing: () => tr('Landing from the sea'), supply: () => tr('Supply'), general: () => tr("General's trait"), readiness: () => tr('Readiness (mobilisation)'),
    counters: () => tr('Counters between unit types'), shells: () => tr('Shells'), flank: () => tr('Attack from several directions'), works: () => tr('Trenches and works'),
    siege: () => tr('Artillery against the works') };
  const ROLES = { engaged: () => tr('Engaged'), waiting: () => tr('Waiting behind'), outside: () => tr('Outside the line'), broken: () => tr('Broken') };
  const MONTHS = () => [tr('January'), tr('February'), tr('March'), tr('April'), tr('May'), tr('June'), tr('July'), tr('August'), tr('September'), tr('October'), tr('November'), tr('December')];

  ui.text = {
    tr,
    particles,
    words,
    reason: lookup(REASONS),
    log: (e) => (e && Object.prototype.hasOwnProperty.call(LOG, e.kind) ? LOG[e.kind](e) : words(e?.kind)),
    // An event that fires logs { kind: 'fired', id } and, through its { log: key } effect, { kind: 'event', key } in
    // the same hour; both read as the same line, so a list shows the 'fired' entry only when no such 'event' exists.
    oncePerEvent: (entries) => {
      const said = new Set(entries.filter((e) => e.kind === 'event').map((e) => `${e.hour}|${e.key}`));
      return entries.filter((e) => e.kind !== 'fired' || !said.has(`${e.hour}|${e.id}`));
    },
    event: lookup(EVENTS),
    alert: lookup(ALERTS),
    ALERT_KINDS: Object.keys(ALERTS),
    terrain: lookup(TERRAIN),
    weather: lookup(WEATHER),
    climate: lookup(CLIMATES),
    trait: lookup(TRAITS),
    bloc: (b) => (b ? lookup(BLOCS)(b) : tr('No bloc')),
    branch: lookup(BRANCHES),
    action: lookup(ACTIONS),
    difficulty: lookup(DIFFICULTY),
    item: lookup(ITEMS),
    building: lookup(BUILDINGS),
    resource: lookup(RESOURCES),
    combat: lookup(COMBAT),
    role: lookup(ROLES),
    COMBAT_KEYS: Object.keys(COMBAT),
    nation: (name) => (name ? tr(name) : ''),
    // { y, m, d, h } -> "28 June 1914" (with the hour: "28 June 1914, 14:00").
    date(d, hour = false) {
      const s = tr('{d} {month} {y}', { d: d.d, month: MONTHS()[d.m - 1], y: d.y });
      return hour ? tr('{date}, {h}:00', { date: s, h: String(d.h).padStart(2, '0') }) : s;
    },
    number: (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : Math.abs(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))),
    percent: (permille) => `${Math.round((permille || 0) / 10)}%`,
  };
  // ---- diplomacy and the judgment panel (ui/panel-diplomacy.js, ui/panel-judgment.js, ui/endgame.js) ----
  // A decision's chosen option, its options and its factors (sim/ai/explain.js labels with args), the ledger kinds of
  // sim/ai/memory.js, the reply keys of diplomacy.evaluate, goals, personality, layers and outcomes. Each entry is
  // (args, f) => text, f naming the values: f.N nation, f.P province, f.num, f.pct (permille), f.score (1000 = 1.0),
  // f.item, f.bloc, f.goal, f.template. With mark, f wraps names in markers that parts() splits, so a screen can make
  // provinces clickable.
  const has = (a, k) => a[k] !== undefined && a[k] !== null;
  const actionWords = (k) => (ACTIONS[k] ? ACTIONS[k]() : words(k));
  const DECISIONS = {
    'goal-weight': (a, f) => (has(a, 'to') ? tr('Goal "{goal}": weight {from} to {to}', { goal: f.goal(a.goal), from: f.score(a.from), to: f.score(a.to) }) : tr('Goal "{goal}"', { goal: f.goal(a.goal) })),
    'answer-accept': (a, f) => tr('Accepted the offer of {nation}: {action}', { nation: f.N(a.nation), action: actionWords(a.action) }),
    'answer-refuse': (a, f) => tr('Refused the offer of {nation}: {action}', { nation: f.N(a.nation), action: actionWords(a.action) }),
    accept: () => tr('Accept the offer'),
    refuse: () => tr('Refuse (its threshold)'),
    'main-enemy': (a, f) => (a.posture === 'attack' ? tr('{nation} becomes the main enemy, to attack', { nation: f.N(a.nation) }) : tr('{nation} becomes the main enemy, to hold against', { nation: f.N(a.nation) })),
    target: (a, f) => tr('Fight {nation} first', { nation: f.N(a.nation) }),
    'declare-war': (a, f) => tr('Declare war on {nation}', { nation: f.N(a.nation) }),
    'join-war': (a, f) => (has(a, 'ally') ? tr('Join the war of {ally} against {nation}', { ally: f.N(a.ally), nation: f.N(a.nation) }) : tr('Join the war against {nation}', { nation: f.N(a.nation) })),
    'stay-out': () => tr('Stay out of the war (its threshold)'),
    'keep-peace': (a, f) => (has(a, 'nation') ? tr('Keep the peace with {nation}', { nation: f.N(a.nation) }) : tr('Keep the peace (its threshold)')),
    'join-bloc': (a, f) => tr('Join the {bloc}', { bloc: f.bloc(a.bloc) }),
    'offer-peace': (a, f) => tr('Offer peace to {nation}, taking {take} and giving {give} provinces', { nation: f.N(a.nation), take: f.num(a.take), give: f.num(a.give) }),
    'peace-terms': (a, f) => tr('Terms taking {take} and giving {give} provinces', { take: f.num(a.take), give: f.num(a.give) }),
    production: (a, f) => {
      const lines = Object.keys(a).filter((k) => ITEMS[k]).map((k) => tr('{item} {n}', { item: f.item(k), n: f.num(a[k]) }));
      return lines.length ? tr('Production lines: {lines}', { lines: lines.join(', ') }) : tr('Production lines');
    },
    train: (a, f) => tr('Train {count} divisions of {template} in {province}', { count: f.num(a.count), template: f.template(a.template), province: f.P(a.province) }),
    mobilise: (a, f) => tr('Mobilisation to {level}', { level: f.pct(a.level) }),
    'offensive-toward': (a, f) => (has(a, 'to') ? tr('Offensive into {to} toward {province}', { to: f.P(a.to), province: f.P(a.province) }) : tr('Offensive toward {province}', { province: f.P(a.province) })),
    'offensive-section': (a, f) => tr('Attack from {from} into {to}, toward {province}', { from: f.P(a.from), to: f.P(a.to), province: f.P(a.province) }),
    'offensive-called-off': (a, f) => tr('Offensive toward {province} called off: {reason}', { province: f.P(a.province), reason: FACTORS[`stop-${a.reason}`] ? FACTORS[`stop-${a.reason}`](a, f) : words(a.reason) }),
  };
  const FACTORS = {
    goal: () => tr('Its goals'),
    grudge: (a, f) => tr('Grudge against {nation}', { nation: f.N(a.nation) }),
    trust: (a, f) => tr('Trust in {nation}', { nation: f.N(a.nation) }),
    strength: (a, f) => (has(a, 'nation') ? tr('Strength against {nation}', { nation: f.N(a.nation) }) : tr('Strength of both camps')),
    'busy-us': () => tr('Already fighting a war'),
    'busy-them': (a, f) => tr('{nation} is already at war', { nation: f.N(a.nation) }),
    fatigue: () => tr('War fatigue'),
    noise: () => tr('Chance (easy difficulty)'),
    threat: (a, f) => (has(a, 'nation') ? tr('Threat from {nation}', { nation: f.N(a.nation) }) : tr('Threat to it')),
    'at-war': () => tr('At war'),
    lacks: (a, f) => tr('Short of {item}', { item: f.item(a.item) }),
    steady: (a, f) => tr('Steady need of {item}', { item: f.item(a.item) }),
    progress: () => tr('Progress toward the goal'),
    reached: () => tr('Goal reached'),
    'under-attack': (a, f) => tr('{nation} is under attack', { nation: f.N(a.nation) }),
    'at-peace': (a, f) => (has(a, 'nation') ? tr('{nation} is at peace', { nation: f.N(a.nation) }) : tr('At peace with everyone')),
    gone: () => tr('No longer possible'),
    joined: () => tr('Already joined'),
    'condition-met': () => tr('Its condition holds'),
    'condition-not-met': () => tr('Its condition does not hold'),
    memory: (a, f) => tr('Remembers: {memory}', { memory: MEMORY[a.kind] ? MEMORY[a.kind](a, f) : words(a.kind) }),
    revanchism: () => tr('Revanchism'),
    loyalty: () => tr('Loyalty'),
    'memory-trust': (a, f) => tr('Trust in {nation}', { nation: f.N(a.nation) }),
    'memory-grudge': (a, f) => tr('Grudge against {nation}', { nation: f.N(a.nation) }),
    'grudge-against-enemy': (a, f) => tr('Grudge against the enemy, {nation}', { nation: f.N(a.nation) }),
    'trust-in-enemy': (a, f) => tr('Trust in the enemy, {nation}', { nation: f.N(a.nation) }),
    'same-bloc': () => tr('Same bloc'),
    'allied-both': (a, f) => tr('Also allied with {nation}', { nation: f.N(a.nation) }),
    weakened: () => tr('Weakened after a collapse'),
    'common-enemy': () => tr('A common enemy'),
    'dragged-into-war': () => tr('Would be drawn into a war'),
    'betrayed-us': (a, f) => tr('{nation} betrayed us', { nation: f.N(a.nation) }),
    'their-war': () => tr('Not its war'),
    terms: () => tr('The terms'),
    'allies-fighting': () => tr('Its allies still fight'),
    'war-length': () => tr('Length of the war'),
    'strength-ratio': (a, f) => tr('Odds of the attack ({odds})', { odds: f.pct(a.odds) }),
    terrain: (a, f) => tr('Terrain of {province}', { province: f.P(a.province) }),
    river: (a, f) => tr('River before {province}', { province: f.P(a.province) }),
    entrenchment: (a, f) => tr('Trenches in {province}', { province: f.P(a.province) }),
    'objective-value': (a, f) => tr('Worth of {province}', { province: f.P(a.province) }),
    encirclement: (a, f) => tr('Encirclement near {province}', { province: f.P(a.province) }),
    supply: () => tr('Supply'),
    'no-front': (a, f) => tr('No front with {nation}', { nation: f.N(a.nation) }),
    'stop-done': () => tr('Objective reached'),
    'stop-blocked': () => tr('The way is blocked'),
    'stop-posture': () => tr('Ordered to hold'),
    'stop-supply': () => tr('Out of supply'),
    'stop-odds': () => tr('The odds are too poor'),
    base: () => tr('Its usual stance'),
  };
  const MEMORY = {
    betrayal: (a, f) => tr('{nation} betrayed us', { nation: f.N(a.nation) }),
    'attacked-us': (a, f) => tr('{nation} attacked us', { nation: f.N(a.nation) }),
    'helped-us': (a, f) => tr('{nation} came to our aid', { nation: f.N(a.nation) }),
    'took-our-core': (a, f) => tr('{nation} took our core land', { nation: f.N(a.nation) }),
    'took-our-land': (a, f) => tr('{nation} took our land', { nation: f.N(a.nation) }),
    'broke-promise': (a, f) => tr('{nation} broke a promise', { nation: f.N(a.nation) }),
    'kept-promise': (a, f) => tr('{nation} kept a promise', { nation: f.N(a.nation) }),
    'defeated-us': (a, f) => tr('{nation} defeated us', { nation: f.N(a.nation) }),
    'defeated-them': (a, f) => tr('We defeated {nation}', { nation: f.N(a.nation) }),
    'made-peace': (a, f) => tr('Made peace with {nation}', { nation: f.N(a.nation) }),
  };
  const REPLIES = {
    'reply-alliance-yes': (a, f) => tr('{nation} accepts the alliance.', { nation: f.N(a.nation) }),
    'reply-alliance-no': (a, f) => tr('{nation} declines the alliance.', { nation: f.N(a.nation) }),
    'reply-access-yes': (a, f) => tr('{nation} grants military access.', { nation: f.N(a.nation) }),
    'reply-access-no': (a, f) => tr('{nation} refuses military access.', { nation: f.N(a.nation) }),
    'reply-peace-yes': (a, f) => tr('{nation} accepts the peace.', { nation: f.N(a.nation) }),
    'reply-peace-no': (a, f) => tr('{nation} rejects the peace.', { nation: f.N(a.nation) }),
    'reply-call-yes': (a, f) => tr('{nation} answers the call to arms.', { nation: f.N(a.nation) }),
    'reply-call-no': (a, f) => tr('{nation} refuses the call to arms.', { nation: f.N(a.nation) }),
    'reply-offer-yes': (a, f) => tr('{nation} accepts.', { nation: f.N(a.nation) }),
    'reply-offer-no': (a, f) => tr('{nation} refuses.', { nation: f.N(a.nation) }),
  };
  const GOAL_NAMES = {
    'hold-london': () => tr('London'), suez: () => tr('Suez'), 'german-colonies': () => tr('the German colonies'), 'hold-paris': () => tr('Paris'),
    'alsace-lorraine': () => tr('Alsace-Lorraine'), 'hold-capital': () => tr('the capital'), galicia: () => tr('Galicia'), 'east-prussia': () => tr('East Prussia'),
    straits: () => tr('the Straits'), 'hold-berlin': () => tr('Berlin'), paris: () => tr('Paris'), 'hold-vienna': () => tr('Vienna'), serbia: () => tr('Serbia'),
    tyrol: () => tr('Tyrol'), bosnia: () => tr('Bosnia'), irredenta: () => tr('the unredeemed lands'), libya: () => tr('Libya'), kars: () => tr('Kars'),
    mesopotamia: () => tr('Mesopotamia'), 'hold-home': () => tr('the homeland'), philippines: () => tr('the Philippines'), 'hold-tokyo': () => tr('Tokyo'),
    'german-pacific': () => tr('the German Pacific islands'), korea: () => tr('Korea'), 'hold-belgrade': () => tr('Belgrade'), 'hold-cetinje': () => tr('Cetinje'),
    'hold-brussels': () => tr('Brussels'), fortresses: () => tr('the fortresses'), 'hold-bucharest': () => tr('Bucharest'), transylvania: () => tr('Transylvania'),
    'hold-sofia': () => tr('Sofia'), macedonia: () => tr('Macedonia'), 'hold-athens': () => tr('Athens'),
  };
  const TRAITS_P = {
    boldness: { name: () => tr('Boldness'), hi: () => tr('Bold'), lo: () => tr('Timid') },
    caution: { name: () => tr('Caution'), hi: () => tr('Cautious'), lo: () => tr('Reckless') },
    loyalty: { name: () => tr('Loyalty'), hi: () => tr('Loyal'), lo: () => tr('Fickle') },
    revanchism: { name: () => tr('Revanchism'), hi: () => tr('Vengeful'), lo: () => tr('Forgiving') },
  };
  const LAYERS = { nation: () => tr('Nation'), operations: () => tr('Operations'), general: () => tr('Army general') };
  const OUTCOMES = {
    'bloc-defeated': (o) => tr('The {bloc} are defeated', { bloc: o.bloc ? lookup(BLOCS)(o.bloc) : tr('No bloc') }),
    'general-peace': () => tr('Peace has returned'),
    'end-date': () => tr('The war ran to its last day'),
  };

  // Score and delta: 1000 = 1.0, shown with two decimals ("0.38", "+0.35", "−0.12").
  const score = (x) => ((x | 0) / 1000).toFixed(2);
  const signed = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs((x | 0) / 1000).toFixed(2)}`;
  const gm = () => Conquest.game;
  function namer(mark, owner) {
    const wrap = (kind, value, text) => (mark ? `\u0001${kind}:${value}:${text}\u0002` : text);
    const goalOf = (id) => (gm()?.scenario?.nations[owner]?.goals || []).find((g) => g.id === id) || null;
    const f = {
      N: (i) => wrap('nation', i, Number.isInteger(i) && i >= 0 ? N(i) : '?'),
      P: (id) => wrap('province', id, Number.isInteger(id) && id > 0 ? P(id) : '?'),
      num: (x) => String(x ?? 0),
      pct: (x) => ui.text.percent(x),
      score,
      item: (k) => (ITEMS[k] ? ITEMS[k]() : words(k)),
      bloc: (b) => (b ? lookup(BLOCS)(b) : tr('No bloc')),
      template: (id) => (gm()?.scenario?.nations[owner]?.templates || []).find((t) => t.id === id)?.name || words(id),
      goal: (id) => ui.text.goal(goalOf(id) || { id }, owner, f),
    };
    return f;
  }
  // text with markers -> [{ text } | { text, province } | { text, nation }]
  function parts(s) {
    const out = [];
    let i = 0;
    for (const m of s.matchAll(/\u0001(\w+):(-?\d+):([^\u0002]*)\u0002/g)) {
      if (m.index > i) out.push({ text: s.slice(i, m.index) });
      out.push({ text: m[3], [m[1]]: Number(m[2]) });
      i = m.index + m[0].length;
    }
    if (i < s.length) out.push({ text: s.slice(i) });
    return out;
  }
  const render = (table) => (label, args, owner = -1, mark = false) => {
    const f = namer(mark, owner);
    const s = Object.prototype.hasOwnProperty.call(table, label) ? table[label](args || {}, f) : words(label);
    return mark ? parts(s) : s;
  };

  Object.assign(ui.text, {
    // decision(label, args, nation, true) -> parts; without the last argument a plain string. nation: whose decision.
    decision: render(DECISIONS),
    factor: render(FACTORS),
    // memory(kind, about) -> "Germany attacked us"
    memory: (kind, about, mark = false) => render(MEMORY)(kind, { nation: about }, -1, mark),
    // reply('reply-peace-yes', { nation, because }) -> "France accepts the peace. The main reason: war fatigue."
    reply(key, args) {
      const f = namer(false, -1);
      const nation = args?.nation ?? -1;
      const first = Object.prototype.hasOwnProperty.call(REPLIES, key) ? REPLIES[key]({ nation }, f) : words(key);
      const b = args?.because;
      if (!b) return first;
      const why = Object.prototype.hasOwnProperty.call(REASONS, b) ? REASONS[b]() : Object.prototype.hasOwnProperty.call(FACTORS, b) ? FACTORS[b](args.becauseArgs || {}, f) : words(b);
      return `${first} ${tr('The main reason: {reason}.', { reason: why.replace(/[.]$/, '') })}`;
    },
    // A goal from the nation query (or { id }): "Take Alsace-Lorraine", "Defend Belgium", "Join the Entente".
    goal(g, owner = -1, f = namer(false, owner)) {
      const id = g.id || '';
      const rev = /^retake-(core|land)-(.+)$/.exec(id);
      if (rev) {
        const i = gm()?.nations?.findIndex((x) => x.tag === rev[2]) ?? -1;
        return rev[1] === 'core' ? tr('Retake its core land from {nation}', { nation: f.N(i) }) : tr('Retake its land from {nation}', { nation: f.N(i) });
      }
      const name = GOAL_NAMES[id] ? GOAL_NAMES[id]() : words(id.replace(/^hold-/, ''));
      switch (g.kind) {
        case 'take': return tr('Take {name}', { name });
        case 'hold': return tr('Hold {name}', { name });
        case 'defend': return Number.isInteger(g.nation) && g.nation >= 0 ? tr('Defend {nation}', { nation: f.N(g.nation) }) : tr('Defend {name}', { name });
        case 'join': return tr('Join the {bloc}', { bloc: f.bloc(g.bloc) });
        default: return name;
      }
    },
    // { boldness, caution, loyalty, revanchism } -> [{ trait, value, level: 'hi' | 'lo' | 'mid', text, title }]
    personality: (p) => Object.keys(TRAITS_P).map((t) => {
      const v = p?.[t] ?? 50;
      const level = v >= 67 ? 'hi' : v <= 33 ? 'lo' : 'mid';
      return { trait: t, value: v, level, text: level === 'mid' ? TRAITS_P[t].name() : TRAITS_P[t][level](), title: tr('{trait}: {value} of 100', { trait: TRAITS_P[t].name(), value: v }) };
    }),
    layer: lookup(LAYERS),
    outcome: (o) => (o && OUTCOMES[o.kind] ? OUTCOMES[o.kind](o) : words(o?.kind)),
    score,
    signed,
    // Every key the tables above translate (tests check that none shows raw).
    KEYS: [...Object.keys(DECISIONS), ...Object.keys(FACTORS), ...Object.keys(MEMORY), ...Object.keys(REPLIES)],
  });
})();
