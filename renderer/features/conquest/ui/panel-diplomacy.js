// The diplomacy panel (plan 3.8 and 7): offers to the player with accept and refuse (an offer alert's click opens
// them; while one waits the dock tab carries a count), the offers the player sent that wait for an answer, the
// player's own bloc and mobilisation, every nation grouped by relation to the player (our bloc and allies, neutral,
// at war; majors first; searchable; a click on its land in the diplomacy map mode picks one too), and for the picked
// nation: its relations with us, its personality, its trust and grudge toward us and toward a third nation, its
// historical goals with their current weight, its ledger of what it remembers, and the actions, each enabled exactly
// when the `legal` query takes it and otherwise showing the translated reason. An offer is first a proposal with the
// live `evaluate` preview (score against threshold and the factors, redone as its terms change); the reply comes on
// the addressee's next day and shows as the canned sentence, and, with conquest.llmReplies on, under it the same
// reply worded by Claude in the voice of that nation (conquest:wording; the decision never comes from it).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const log = ide.logger('#conquest');
  const game = Conquest.game;
  const shell = ui.shell;
  const dip = ui.dip;

  const PREVIEW_MS = 150;
  const ROW = 24;
  const LEDGER_ROW = 22;
  const SHORT = { 'offer-alliance': 'alliance', 'ask-access': 'access', 'offer-peace': 'peace', 'call-to-arms': 'call' };
  const MOB_LEVELS = [0, 250, 500, 750, 1000];
  const LLM_SETTING = 'conquest.llmReplies';

  // The actions with a nation, in the order shown; offer: true opens a proposal with the preview first.
  const ACTIONS = [
    { id: 'declare-war', label: () => tr('Declare War'), danger: true },
    { id: 'offer-alliance', label: () => tr('Offer Alliance'), offer: true },
    { id: 'break-alliance', label: () => tr('Break Alliance') },
    { id: 'ask-access', label: () => tr('Ask Military Access'), offer: true },
    { id: 'call-to-arms', label: () => tr('Call to Arms'), offer: true },
    { id: 'offer-peace', label: () => tr('Offer Peace'), offer: true },
    { id: 'join-bloc', label: () => tr('Join Its Bloc') },
  ];

  // ---------- what the panel remembers between mounts ----------
  const sent = new Map(); // offer id -> { to, action, preview }
  let reply = null; // { offer, to, action, yes, text, factors, llm: null | text, asking }
  let proposal = null; // { action, to, against, take: [], give: [] }
  let view = null; // the mounted panel's parts

  const short = (action) => SHORT[action] || 'offer';
  const offersToUs = () => (game.offers || []).filter((o) => o.to === game.player);
  const offersFromUs = () => (game.offers || []).filter((o) => o.from === game.player);

  function updateBadge() {
    const n = game.running ? offersToUs().length : 0;
    const root = shell.root;
    if (!root) return;
    root.style.setProperty('--cq-dip-offers', String(n));
    root.classList.toggle('cq-dip-has-offers', n > 0);
  }

  // ---------- replies ----------
  async function onAnswer(e) {
    const s = sent.get(e.offer);
    if (!s) return;
    sent.delete(e.offer);
    const yes = e.kind === 'accepted';
    let key = `reply-${short(s.action)}-${yes ? 'yes' : 'no'}`;
    let factors = s.preview?.factors || [];
    let because = s.preview?.reply?.args?.because || null;
    let becauseArgs = null;
    try {
      const decisions = await game.query('explain', { nation: e.to });
      const d = decisions.find((x) => x.chosen?.args?.offer === e.offer);
      if (d) {
        key = d.chosen.args.reply || key;
        factors = d.factors;
        const f = d.factors.find((x) => (yes ? x.delta > 0 : x.delta < 0));
        because = f ? f.label : 'base';
        becauseArgs = f?.args || null;
      }
    } catch {}
    const text = ui.text.reply(key, { nation: e.to, because, becauseArgs });
    reply = { offer: e.offer, to: e.to, action: s.action, yes, key, text, factors, llm: null, asking: false };
    renderReply();
    if (ide.settings.get(LLM_SETTING, false)) askWording(reply);
  }

  async function askWording(r) {
    r.asking = true;
    renderReply();
    const payload = {
      nation: game.nationName(r.to),
      year: game.date().y,
      decision: `${r.yes ? 'accepts' : 'refuses'} ${r.action}`,
      factors: (r.factors || []).slice(0, 3).map((f) => `${ui.text.factor(f.label, f.args, r.to)} (${ui.text.signed(f.delta)})`),
      canned: r.text,
      language: document.documentElement.lang === 'ko' ? 'Korean' : 'English',
    };
    let res = null;
    try { res = await ide.api.invoke('conquest:wording', payload); } catch (err) { log.warn(`wording: ${err?.message || err}`); }
    r.asking = false;
    if (res?.ok && typeof res.text === 'string' && res.text.trim()) r.llm = res.text.trim();
    if (reply === r) renderReply();
  }

  function renderReply() {
    if (!view) return;
    const v = view.reply;
    v.box.hidden = !reply;
    if (!reply) return;
    v.box.dataset.offer = String(reply.offer);
    v.box.dataset.accepted = String(reply.yes);
    v.who.replaceChildren(dip.chip(reply.to), dip.nameEl(reply.to));
    v.canned.textContent = reply.text;
    v.llm.hidden = !reply.llm;
    v.llmText.textContent = reply.llm || '';
    v.asking.hidden = !reply.asking;
  }

  game.on('event', (e) => { if ((e.kind === 'accepted' || e.kind === 'refused') && e.from === game.player && sent.has(e.offer)) onAnswer(e); });
  game.on('offers', () => { updateBadge(); if (view && !view.root.hidden) renderOutbox(); });
  ui.events.on('offers-changed', () => { if (view && !view.root.hidden) renderInbox(); });
  game.on('day', () => { if (view && !view.root.hidden && offersToUs().length) renderInbox(); });
  game.on('loaded', () => { sent.clear(); reply = null; proposal = null; dip.selected = null; updateBadge(); });
  game.on('closed', () => { updateBadge(); });

  // Opened by an offer alert.
  ui.events.on('open-offer', () => {
    dip.openPanel('diplomacy');
    requestAnimationFrame(() => view?.inbox.box.scrollIntoView({ block: 'nearest' }));
  });

  // A click on land: the terms editor takes it when open; in the diplomacy map mode it picks the nation.
  game.on('select', (sel) => {
    const p = sel.province;
    if (!game.running || !(p > 0) || game.map.provinces[p]?.sea) return;
    if (proposal?.action === 'offer-peace' && view && !view.root.hidden) {
      const owner = game.prov.owner[p];
      if (owner === proposal.to) toggleTerm('take', p);
      else if (owner === game.player) toggleTerm('give', p);
      return;
    }
    if (shell.view?.mode !== 'diplomacy') return;
    const owner = game.prov.owner[p];
    if (owner >= 0 && owner !== game.player) {
      dip.select(owner);
      dip.openPanel('diplomacy');
    }
  });

  // ---------- the panel ----------
  ui.panel({
    id: 'diplomacy', title: tr('Diplomacy'), icon: 'diagram', order: 300,
    mount(root) {
      view = build(root);
      const offSel = ui.events.on('dip-select', () => { if (!root.hidden) { proposal = proposal && proposal.to === dip.selected ? proposal : null; renderList(); renderDetail(); } });
      return {
        update() { refresh(); },
        destroy() { offSel(); view = null; proposal = null; },
      };
    },
  });

  function section(cls, title) {
    const box = el('div', `cq-dip-section ${cls}`);
    const head = el('div', 'cq-dip-section-title', title);
    box.append(head);
    return { box, head };
  }

  function build(root) {
    const wrap = el('div', 'cq-dip');
    const tools = el('div', 'cq-dip-tools');
    const wide = el('button', 'cq-btn cq-dip-wide-btn', tr('Wide View'));
    wide.onclick = () => { wrap.classList.toggle('wide'); wide.classList.toggle('active', wrap.classList.contains('wide')); };
    tools.append(wide);

    const inbox = section('cq-dip-inbox', tr('Offers to Us'));
    const inboxList = el('div', 'cq-dip-offers');
    inbox.box.append(inboxList);
    const outbox = section('cq-dip-outbox', tr('Waiting for an Answer'));
    const outboxList = el('div', 'cq-dip-offers');
    outbox.box.append(outboxList);

    const rep = section('cq-dip-reply', tr('Their Reply'));
    const who = el('div', 'cq-dip-reply-who');
    const canned = el('div', 'cq-dip-reply-canned');
    const llm = el('div', 'cq-dip-reply-llm');
    const llmMark = el('span', 'cq-dip-llm-mark', tr('Worded by Claude'));
    const llmText = el('span', 'cq-dip-reply-llm-text');
    llmText.dataset.userText = '';
    llm.append(llmMark, llmText);
    const asking = el('div', 'cq-dip-reply-asking', tr('Asking Claude for the wording…'));
    rep.box.append(who, canned, llm, asking);

    const llmRow = el('label', 'cq-dip-llm-setting');
    const llmBox = document.createElement('input');
    llmBox.type = 'checkbox';
    llmBox.className = 'cq-dip-llm-toggle';
    llmBox.checked = !!ide.settings.get(LLM_SETTING, false);
    llmBox.onchange = () => ide.settings.set(LLM_SETTING, llmBox.checked);
    llmRow.append(llmBox, el('span', null, tr('Word replies with Claude')), el('span', 'cq-dip-note', tr('Uses your Claude usage each time.')));

    const self = section('cq-dip-self', tr('Our Nation'));
    const selfBloc = el('div', 'cq-dip-self-bloc');
    const leave = actionRow({ id: 'leave-bloc', label: () => tr('Leave Bloc') });
    const mob = el('div', 'cq-dip-mob');
    const mobLabel = el('div', 'cq-dip-mob-label');
    const mobBtns = el('div', 'cq-seg cq-dip-mob-levels');
    for (const lv of MOB_LEVELS) {
      const b = el('button', 'cq-seg-btn', ui.text.percent(lv));
      b.dataset.level = String(lv);
      b.onclick = () => send({ type: 'diplo', action: 'mobilise', level: lv });
      mobBtns.append(b);
    }
    const readyLabel = el('div', 'cq-dip-ready-label');
    readyLabel.title = tr('Our divisions fight at this share of their strength. It rises day by day once we mobilise fully or go to war.');
    mob.append(mobLabel, mobBtns, readyLabel);
    self.box.append(selfBloc, leave.row, mob, llmRow);

    const cols = el('div', 'cq-dip-cols');
    const left = el('div', 'cq-dip-left');
    const search = document.createElement('input');
    search.className = 'cq-input cq-dip-search';
    search.placeholder = tr('Search nations');
    search.oninput = () => renderList();
    const list = dip.vlist('cq-dip-nations', ROW, nationRow);
    left.append(search, list.el);

    const detail = el('div', 'cq-dip-detail');
    const empty = el('div', 'cq-dip-empty', tr('Pick a nation from the list, or click its land in the diplomacy map mode.'));
    const body = el('div', 'cq-dip-body');
    const head = el('div', 'cq-dip-head');
    const relLine = el('div', 'cq-dip-rel');
    const chips = el('div', 'cq-dip-chips');
    const feel = el('div', 'cq-dip-feel');
    const feelTitle = el('div', 'cq-dip-sub', tr('Its feelings toward us'));
    const usTrust = dip.meter('trust');
    const usGrudge = dip.meter('grudge');
    usTrust.el.classList.add('cq-dip-us');
    usGrudge.el.classList.add('cq-dip-us');
    const thirdRow = el('div', 'cq-dip-third-row');
    const third = document.createElement('select');
    third.className = 'cq-select cq-dip-third';
    third.onchange = () => renderDetail();
    thirdRow.append(el('span', 'cq-dip-sub', tr('And toward')), third);
    const thTrust = dip.meter('trust');
    const thGrudge = dip.meter('grudge');
    thTrust.el.classList.add('cq-dip-them');
    thGrudge.el.classList.add('cq-dip-them');
    feel.append(feelTitle, usTrust.el, usGrudge.el, thirdRow, thTrust.el, thGrudge.el);

    const acts = el('div', 'cq-dip-actions');
    const rows = {};
    for (const a of ACTIONS) { rows[a.id] = actionRow(a); acts.append(rows[a.id].row); }
    const against = document.createElement('select');
    against.className = 'cq-select cq-dip-against';
    against.onchange = () => { if (proposal?.action === 'call-to-arms') { proposal.against = Number(against.value); schedulePreview(); } renderDetail(); };
    rows['call-to-arms'].row.append(against);

    const prop = buildProposal();
    const goals = section('cq-dip-goals', tr('Historical Goals'));
    const goalList = el('div', 'cq-dip-goal-list');
    goals.box.append(goalList);
    const ledger = section('cq-dip-ledger', tr('What It Remembers'));
    const ledgerList = dip.vlist('cq-dip-ledger-list', LEDGER_ROW, ledgerRow);
    const ledgerEmpty = el('div', 'cq-dip-empty', tr('Nothing yet.'));
    ledger.box.append(ledgerEmpty, ledgerList.el);

    body.append(head, relLine, chips, feel, acts, prop.box, goals.box, ledger.box);
    detail.append(empty, body);
    cols.append(left, detail);
    wrap.append(tools, inbox.box, outbox.box, rep.box, self.box, cols);
    root.append(wrap);
    return {
      root, wrap, inbox: { box: inbox.box, list: inboxList }, outbox: { box: outbox.box, list: outboxList },
      reply: { box: rep.box, who, canned, llm, llmText, asking }, llmBox,
      self: { box: self.box, bloc: selfBloc, leave, mobLabel, mobBtns, readyLabel },
      search, list, detail: { empty, body, head, relLine, chips, usTrust, usGrudge, third, thTrust, thGrudge, rows, against, goalList, ledgerList, ledgerEmpty },
      prop,
    };
  }

  function actionRow(a) {
    const row = el('div', 'cq-dip-action');
    row.dataset.action = a.id;
    const b = el('button', `cq-btn cq-dip-act${a.danger ? ' danger' : ''}`, a.label());
    b.dataset.action = a.id;
    b.disabled = true;
    const why = el('span', 'cq-dip-why');
    row.append(b, why);
    b.onclick = () => runAction(a.id);
    return { row, button: b, why };
  }

  // ---------- refresh ----------
  let seq = 0;
  function refresh() {
    if (!view || !game.running) return;
    view.llmBox.checked = !!ide.settings.get(LLM_SETTING, false);
    if (dip.selected === null || !game.nations[dip.selected]) dip.selected = dip.mainEnemy();
    renderInbox();
    renderOutbox();
    renderReply();
    renderSelf();
    renderList();
    renderDetail();
  }

  function provinceButtons(ids) {
    const span = el('span', 'cq-dip-provs');
    ids.forEach((p, i) => {
      if (i) span.append(document.createTextNode(', '));
      span.append(dip.partsEl([{ text: game.map.provinces[p]?.name || '?', province: p }]));
    });
    return span;
  }

  // incoming: false (sent by us) or { gone: null | 'expired' | 'overtaken', stale: null | reason key }.
  function offerCard(o, incoming) {
    const card = el('div', 'cq-dip-offer');
    card.dataset.offer = String(o.id);
    card.dataset.action = o.action;
    const other = incoming ? o.from : o.to;
    const top = el('div', 'cq-dip-offer-top');
    top.append(dip.chip(other), dip.nameEl(other), el('span', 'cq-dip-offer-kind', ui.text.action(o.action)));
    card.append(top);
    const line = (text) => card.append(el('div', 'cq-dip-offer-line', text));
    const N = (i) => game.nationName(i);
    if (incoming) {
      const against = o.terms?.against;
      if (o.action === 'call-to-arms') {
        line(tr('{nation} asks us to join its war against {enemy}.', { nation: N(o.from), enemy: N(against) }));
        card.append(el('div', 'cq-dip-offer-means', tr('Accepting puts us at war with {enemy}.', { enemy: N(against) })));
      } else if (o.action === 'offer-alliance') {
        line(tr('{nation} offers an alliance.', { nation: N(o.from) }));
        card.append(el('div', 'cq-dip-offer-means', tr('Accepting makes us allies: its wars can call on us.')));
      } else if (o.action === 'ask-access') {
        line(tr('{nation} asks for military access.', { nation: N(o.from) }));
        card.append(el('div', 'cq-dip-offer-means', tr('Accepting lets its divisions cross our land.')));
      } else if (o.action === 'offer-peace') {
        line(tr('{nation} offers peace.', { nation: N(o.from) }));
        const take = o.terms?.take || [];
        const give = o.terms?.give || [];
        if (give.length) { const r = el('div', 'cq-dip-offer-line', tr('We receive:')); r.append(' ', provinceButtons(give)); card.append(r); }
        if (take.length) { const r = el('div', 'cq-dip-offer-line', tr('We hand over:')); r.append(' ', provinceButtons(take)); card.append(r); }
        card.append(el('div', 'cq-dip-offer-means', take.length || give.length ? tr('Accepting ends the war and hands over the named provinces; all other occupied land goes back.') : tr('Accepting ends the war; all occupied land goes back.')));
      }
      const again = incoming.gone ? 0 : shell.offerRepeats(o);
      if (again) {
        const tag = el('span', 'cq-dip-tag cq-dip-again', tr('Offered again: {n} times', { n: again + 1 }));
        tag.title = tr('You refused or let lapse this same offer {n} times before; it does not pause the game.', { n: again });
        top.append(tag);
        card.classList.add('again');
      }
      const over = !!game.outcome;
      const dead = over ? tr('The game is over.') : incoming.gone === 'expired' ? tr('Expired on {date} without an answer.', { date: dip.date(o.expires) })
        : incoming.gone || incoming.stale ? tr('No longer valid: the war, the alliance or the land it was about changed since it was made.') : null;
      card.classList.toggle('expired', !!dead);
      if (dead) {
        top.append(el('span', 'cq-dip-tag cq-dip-expired-tag', tr('Offer expired')));
        card.append(el('div', 'cq-dip-offer-exp cq-dip-offer-dead', dead));
      } else card.append(el('div', 'cq-dip-offer-exp', tr('Answer by {date}', { date: dip.date(o.expires) })));
      const btns = el('div', 'cq-dip-offer-btns');
      const yes = el('button', 'cq-btn primary cq-dip-accept', tr('Accept Offer'));
      const no = el('button', 'cq-btn cq-dip-refuse', tr('Refuse Offer'));
      yes.onclick = () => send({ type: 'diplo', action: 'accept', offer: o.id });
      no.onclick = () => send({ type: 'diplo', action: 'refuse', offer: o.id });
      // Still listed, a stale offer can be refused (the simulation takes it, and a refused call to arms is remembered);
      // only Accept is off. One gone from the list, or any after the end, takes neither.
      yes.disabled = !!dead;
      no.disabled = !!dead && (over || !!incoming.gone);
      if (yes.disabled) yes.title = dead;
      if (no.disabled) no.title = dead;
      btns.append(yes, no);
      if (incoming.gone) {
        const x = el('button', 'cq-btn cq-dip-dismiss', tr('Dismiss'));
        x.onclick = () => shell.dismissGoneOffer(o.id);
        btns.append(x);
      }
      card.append(btns);
    } else {
      if (o.action === 'call-to-arms') line(tr('Against {enemy}', { enemy: N(o.terms?.against) }));
      card.append(el('div', 'cq-dip-offer-exp', tr('Sent {date}; the answer comes on its next day.', { date: dip.date(o.hour) })));
    }
    return card;
  }

  // An offer still listed can stop fitting before the simulation's next day drops it (the legal query says so); one
  // that left the list unanswered comes from the shell (offerGone). Each shows as expired with the reason.
  let inboxSeq = 0;
  let inboxSig = '';
  async function renderInbox() {
    const seq = ++inboxSeq;
    const list = offersToUs();
    const stale = new Map();
    if (game.running && !game.outcome) {
      for (const o of list) {
        try {
          const r = await game.query('legal', { order: { type: 'diplo', action: 'accept', offer: o.id } });
          if (!r.ok) stale.set(o.id, r.reason);
        } catch {}
      }
    }
    if (seq !== inboxSeq || !view) return;
    for (const id of stale.keys()) shell.dropOfferToast(id);
    const gone = game.running ? shell.offerGone().sort((a, b) => b.hour - a.hour) : [];
    // Redrawn only when what it shows changed: a card redrawn between press and release loses the click.
    const sig = JSON.stringify([list.map((o) => [o.id, shell.offerRepeats(o)]), [...stale], gone.map((g) => g.offer.id), !!game.outcome, document.documentElement.lang]);
    if (sig === inboxSig && view.inbox.list.isConnected && view.inbox.list.childElementCount) return;
    inboxSig = sig;
    view.inbox.box.hidden = !list.length && !gone.length;
    view.inbox.list.replaceChildren(...list.map((o) => offerCard(o, { gone: null, stale: stale.get(o.id) || null })),
      ...gone.map((g) => offerCard(g.offer, { gone: g.reason, stale: null })));
  }
  function renderOutbox() {
    const list = offersFromUs();
    view.outbox.box.hidden = !list.length;
    view.outbox.list.replaceChildren(...list.map((o) => offerCard(o, false)));
  }

  async function renderSelf() {
    const me = game.nations[game.player];
    const s = view.self;
    s.bloc.textContent = tr('Bloc: {bloc}', { bloc: ui.text.bloc(me?.bloc) });
    const target = game.me?.dip?.mobTarget ?? 0;
    s.mobLabel.textContent = tr('Mobilisation: {now} (target {target})', { now: ui.text.percent(me?.mobilisation ?? 0), target: ui.text.percent(target) });
    s.readyLabel.textContent = tr('Readiness: {now}', { now: ui.text.percent(me?.ready ?? 1000) });
    for (const b of s.mobBtns.children) b.classList.toggle('active', Number(b.dataset.level) === target);
    setLegal(s.leave, await legal({ type: 'diplo', action: 'leave-bloc' }));
  }

  // ---------- the nation list ----------
  function groupOf(x) {
    if (!x.alive) return 'gone';
    if (x.war) return 'war';
    const me = game.nations[game.player];
    if (x.ally || (me?.bloc && x.bloc === me.bloc)) return 'ours';
    return 'neutral';
  }
  const GROUPS = [['ours', () => tr('Our Bloc and Allies')], ['neutral', () => tr('Neutral')], ['war', () => tr('At War with Us')], ['gone', () => tr('Gone')]];

  function renderList() {
    if (!view) return;
    const q = view.search.value.trim().toLowerCase();
    const sc = game.scenario.nations;
    const items = [];
    for (const [g, title] of GROUPS) {
      const members = game.nations.filter((x) => x.index !== game.player && groupOf(x) === g
        && (!q || game.nationName(x.index).toLowerCase().includes(q) || x.tag.toLowerCase().includes(q)));
      if (!members.length) continue;
      members.sort((a, b) => (sc[b.index]?.major ? 1 : 0) - (sc[a.index]?.major ? 1 : 0) || game.nationName(a.index).localeCompare(game.nationName(b.index)));
      items.push({ head: title(), group: g, count: members.length });
      for (const m of members) items.push({ n: m.index, group: g });
    }
    view.list.el.style.height = `${items.length * ROW + 2}px`;
    view.list.set(items);
  }

  function nationRow(item) {
    if (item.head) {
      const h = el('div', `cq-dip-group cq-dip-group-${item.group}`);
      h.append(el('span', null, item.head), el('span', 'cq-dip-count', String(item.count)));
      return h;
    }
    const x = game.nations[item.n];
    const r = el('button', `cq-dip-nation${item.n === dip.selected ? ' active' : ''}`);
    r.dataset.nation = String(item.n);
    r.dataset.group = item.group;
    r.append(dip.chip(item.n), dip.nameEl(item.n, 'cq-dip-nation-name'));
    if (game.scenario.nations[item.n]?.major) r.append(el('span', 'cq-dip-tag', tr('Great Power')));
    if (x.bloc) r.append(el('span', 'cq-dip-tag', ui.text.bloc(x.bloc)));
    if (offersToUs().some((o) => o.from === item.n)) r.append(el('span', 'cq-dip-tag offer', tr('Offer waiting')));
    r.onclick = () => dip.select(item.n);
    return r;
  }

  // ---------- the picked nation ----------
  const legal = (order) => game.query('legal', { order }).catch((err) => ({ ok: false, reason: err.message || 'no-answer' }));

  function setLegal(row, r) {
    row.button.disabled = !r.ok;
    row.row.dataset.ok = String(!!r.ok);
    row.row.dataset.reason = r.ok ? '' : r.reason || '';
    row.why.textContent = r.ok ? '' : r.text || ui.text.reason(r.reason);
    row.why.hidden = !!r.ok;
  }

  const enemiesOf = (to) => game.nations.filter((x) => x.alive && x.war && x.index !== to).map((x) => x.index);

  function orderFor(action, to) {
    const base = { type: 'diplo', action, to };
    if (action === 'call-to-arms') {
      const a = proposal?.action === 'call-to-arms' && proposal.to === to ? proposal.against : Number(view.detail.against.value);
      return { ...base, against: Number.isInteger(a) ? a : -1 };
    }
    if (action === 'offer-peace') {
      const p = proposal?.action === 'offer-peace' && proposal.to === to ? proposal : null;
      return { ...base, terms: { take: p ? p.take.slice() : [], give: p ? p.give.slice() : [] } };
    }
    if (action === 'join-bloc') return { type: 'diplo', action, bloc: game.nations[to]?.bloc || '' };
    return base;
  }

  async function renderDetail() {
    if (!view) return;
    const d = view.detail;
    const n = dip.selected;
    d.empty.hidden = n !== null;
    d.body.hidden = n === null;
    if (n === null) return;
    const my = ++seq;
    const x = game.nations[n];
    d.body.dataset.nation = String(n);

    d.head.replaceChildren(dip.chip(n), dip.nameEl(n, 'cq-dip-title'), el('span', 'cq-dip-tag', ui.text.bloc(x.bloc)),
      ...(game.scenario.nations[n]?.major ? [el('span', 'cq-dip-tag', tr('Great Power'))] : []), ...(!x.alive ? [el('span', 'cq-dip-tag', tr('Gone'))] : []));

    const enemies = enemiesOf(n);
    const keep = d.against.value;
    d.against.replaceChildren(...enemies.map((e) => { const o = document.createElement('option'); o.value = String(e); o.textContent = game.nationName(e); return o; }));
    if (enemies.includes(Number(keep))) d.against.value = keep;
    d.against.hidden = !enemies.length;

    const others = game.nations.filter((y) => y.index !== n && y.alive);
    const keepThird = d.third.value;
    const none = document.createElement('option');
    none.value = '';
    none.textContent = tr('another nation…');
    d.third.replaceChildren(none, ...others.map((y) => { const o = document.createElement('option'); o.value = String(y.index); o.textContent = game.nationName(y.index); return o; }));
    if (others.some((y) => String(y.index) === keepThird)) d.third.value = keepThird;

    const [rels, info, mem, ...legals] = await Promise.all([
      game.query('relations', { nation: game.player }).catch(() => []),
      game.query('nation', { nation: n }).catch(() => null),
      game.query('memory', { nation: n, summary: true }).catch(() => null),
      ...ACTIONS.map((a) => (a.id === 'join-bloc' && !x.bloc ? Promise.resolve({ ok: false, reason: 'its-no-bloc', text: tr('It is in no bloc.') }) : legal(orderFor(a.id, n)))),
    ]);
    if (my !== seq || !view) return;

    const r = rels.find((y) => y.nation === n) || {};
    const bits = [];
    if (r.war) bits.push(r.since !== null && r.since !== undefined ? tr('At war with us since {date}', { date: dip.date(r.since) }) : tr('At war with us'));
    if (r.ally) bits.push(tr('Allied with us'));
    if (r.access && !r.ally) bits.push(tr('Grants us military access'));
    if (r.truce > game.hour) bits.push(tr('Truce until {date}', { date: dip.date(r.truce) }));
    if (!bits.length) bits.push(tr('At peace with us'));
    d.relLine.textContent = bits.join(' · ');
    d.relLine.dataset.war = String(!!r.war);
    d.relLine.dataset.ally = String(!!r.ally);

    d.chips.replaceChildren(...(info?.personality ? ui.text.personality(info.personality).map((c) => {
      const s = el('span', `cq-dip-trait ${c.level}`, c.text);
      s.dataset.trait = c.trait;
      s.title = c.title;
      return s;
    }) : []));

    d.usTrust.set(mem ? mem.trust[game.player] : 0);
    d.usGrudge.set(mem ? mem.grudge[game.player] : 0);
    const t = d.third.value === '' ? null : Number(d.third.value);
    d.thTrust.el.hidden = t === null;
    d.thGrudge.el.hidden = t === null;
    if (t !== null && mem) { d.thTrust.set(mem.trust[t]); d.thGrudge.set(mem.grudge[t]); }

    ACTIONS.forEach((a, i) => setLegal(d.rows[a.id], legals[i]));

    renderGoals(info, n);
    const lines = [];
    for (const row of mem?.about || []) for (const l of row.lines) lines.push({ ...l, about: row.nation });
    lines.sort((a, b) => b.hour - a.hour);
    d.ledgerEmpty.hidden = lines.length > 0;
    d.ledgerList.el.hidden = !lines.length;
    d.ledgerList.el.style.height = `${lines.length * LEDGER_ROW + 2}px`;
    d.ledgerList.set(lines);
    renderProposal();
  }

  function renderGoals(info, n) {
    const list = view.detail.goalList;
    const goals = info?.goals || [];
    if (!goals.length) { list.replaceChildren(el('div', 'cq-dip-empty', tr('No historical goals.'))); return; }
    list.replaceChildren(...goals.map((g) => {
      const row = el('div', 'cq-dip-goal');
      row.dataset.goal = g.id;
      const name = el('span', 'cq-dip-goal-name', ui.text.goal(g, n));
      const bar = el('span', 'cq-dip-goal-bar');
      const fill = el('span', 'cq-dip-goal-fill');
      fill.style.width = `${Math.min(100, g.weight / 10)}%`;
      const mark = el('span', 'cq-dip-goal-base');
      mark.style.left = `${Math.min(100, g.base / 10)}%`;
      bar.append(fill, mark);
      const w = el('span', 'cq-dip-goal-w', ui.text.score(g.weight));
      w.title = tr('Weight now {now}; at the start {base}', { now: ui.text.score(g.weight), base: ui.text.score(g.base) });
      row.append(name, bar, w);
      if (g.progress !== null && g.provinces.length) row.append(el('span', 'cq-dip-goal-prog', tr('{held} of {all} held', { held: g.held, all: g.provinces.length })));
      return row;
    }));
  }

  function ledgerRow(l) {
    const r = el('div', `cq-dip-ledger-row cq-dip-mem-${l.kind}`);
    r.dataset.kind = l.kind;
    r.dataset.about = String(l.about);
    const text = ui.text.memory(l.kind, l.about, true);
    const t = dip.partsEl(text, 'cq-dip-ledger-text');
    t.title = text.map((p) => p.text).join('');
    const eff = el('span', 'cq-dip-ledger-eff', tr('trust {t}, grudge {g}', { t: ui.text.signed(l.trust), g: ui.text.signed(l.grudge) }));
    r.append(el('span', 'cq-dip-ledger-date', dip.date(l.hour)), t, eff);
    return r;
  }

  // ---------- actions ----------
  async function send(order) {
    const r = await game.order(order);
    if (!r.ok) shell.toast(ui.text.reason(r.reason));
    return r;
  }

  async function runAction(id) {
    const n = dip.selected;
    if (n === null) return;
    const a = ACTIONS.find((x) => x.id === id);
    if (a?.offer) {
      const enemies = enemiesOf(n);
      proposal = { action: id, to: n, against: id === 'call-to-arms' ? Number(view.detail.against.value) || enemies[0] : null, take: [], give: [] };
      renderProposal();
      view.prop.box.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (id === 'declare-war') return confirmWar(n);
    if (id === 'break-alliance') {
      const ok = await ide.ui.confirm(tr('End the alliance with {nation}? A war we declare on it in the next 180 days counts as a betrayal in its memory.', { nation: game.nationName(n) }), { title: tr('Break Alliance'), ok: tr('Break Alliance') });
      if (ok) await send(orderFor(id, n));
      return;
    }
    await send(orderFor(id, n));
  }

  async function confirmWar(n) {
    let calls = { ours: [], theirs: [], betrayal: false };
    try { calls = await game.query('calls', { to: n }); } catch {}
    const names = (list) => list.map((i) => game.nationName(i)).join(', ');
    const body = el('div', 'cq-dip-war-confirm');
    body.append(el('div', null, tr('{nation} will be at war with us.', { nation: game.nationName(n) })));
    const ours = el('div', 'cq-dip-war-ours', calls.ours.length ? tr('Called to arms on our side: {list}', { list: names(calls.ours) }) : tr('No one is called to arms on our side.'));
    const theirs = el('div', 'cq-dip-war-theirs', calls.theirs.length ? tr('Called to arms on its side: {list}', { list: names(calls.theirs) }) : tr('No one is called to arms on its side.'));
    ours.dataset.nations = calls.ours.join(',');
    theirs.dataset.nations = calls.theirs.join(',');
    body.append(ours, theirs);
    if (calls.betrayal) body.append(el('div', 'cq-dip-war-betrayal', tr('We ended our alliance with it only recently: it will remember this as a betrayal.')));
    ide.ui.dialog({
      title: tr('Declare War'),
      body,
      width: 420,
      buttons: [{ label: tr('Declare War'), primary: true, run: () => { send(orderFor('declare-war', n)); } }, { label: tr('Cancel') }],
    });
  }

  // ---------- the proposal ----------
  function buildProposal() {
    const box = el('div', 'cq-dip-proposal');
    box.hidden = true;
    const title = el('div', 'cq-dip-section-title cq-dip-prop-title');
    const terms = el('div', 'cq-dip-terms');
    const takeBox = el('div', 'cq-dip-terms-side cq-dip-take');
    const giveBox = el('div', 'cq-dip-terms-side cq-dip-give');
    const takeHead = el('div', 'cq-dip-sub', tr('We take'));
    const giveHead = el('div', 'cq-dip-sub', tr('We give'));
    const takeChosen = el('div', 'cq-dip-terms-chosen');
    const giveChosen = el('div', 'cq-dip-terms-chosen');
    const takeCands = el('div', 'cq-dip-terms-cands');
    const giveCands = el('div', 'cq-dip-terms-cands');
    takeBox.append(takeHead, takeChosen, el('div', 'cq-dip-note', tr('Its land we hold:')), takeCands);
    giveBox.append(giveHead, giveChosen, el('div', 'cq-dip-note', tr('Our land it holds:')), giveCands);
    const totals = el('div', 'cq-dip-terms-totals');
    terms.append(el('div', 'cq-dip-note', tr('Click a province on the map to add it to the terms or take it out.')), takeBox, giveBox, totals);
    const preview = el('div', 'cq-dip-preview');
    const verdict = el('div', 'cq-dip-verdict');
    const bar = el('div', 'cq-dip-bar');
    const fill = el('span', 'cq-dip-bar-fill');
    const mark = el('span', 'cq-dip-bar-mark');
    bar.append(fill, mark);
    const factors = el('div', 'cq-dip-factors');
    preview.append(verdict, bar, factors);
    const btns = el('div', 'cq-dip-prop-btns');
    const sendBtn = el('button', 'cq-btn primary cq-dip-send', tr('Send Offer'));
    const cancel = el('button', 'cq-btn cq-dip-cancel', tr('Close'));
    const why = el('span', 'cq-dip-why');
    btns.append(sendBtn, cancel, why);
    sendBtn.onclick = () => sendProposal();
    cancel.onclick = () => { proposal = null; renderProposal(); };
    box.append(title, terms, preview, btns);
    return { box, title, terms, takeChosen, giveChosen, takeCands, giveCands, totals, preview, verdict, bar, fill, mark, factors, sendBtn, why };
  }

  function toggleTerm(side, p) {
    if (!proposal) return;
    const list = proposal[side];
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1); else list.push(p);
    renderProposal();
  }

  let lastPreview = null;
  let previewTimer = 0;
  let previewSeq = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, PREVIEW_MS);
  }

  function evalTerms(p) {
    return p.action === 'call-to-arms' ? { against: p.against } : p.action === 'offer-peace' ? { take: p.take.slice(), give: p.give.slice() } : {};
  }

  async function runPreview() {
    if (!proposal || !view) return;
    const p = proposal;
    const my = ++previewSeq;
    const [ev, ok] = await Promise.all([
      game.query('evaluate', { to: p.to, action: p.action, terms: evalTerms(p) }).catch(() => null),
      legal(orderFor(p.action, p.to)),
    ]);
    if (my !== previewSeq || proposal !== p || !view) return;
    lastPreview = ev;
    const v = view.prop;
    v.sendBtn.disabled = !ok.ok;
    v.why.textContent = ok.ok ? '' : ui.text.reason(ok.reason);
    if (!ev) { v.preview.hidden = true; return; }
    v.preview.hidden = false;
    v.preview.dataset.score = String(ev.score);
    v.preview.dataset.threshold = String(ev.threshold);
    v.preview.dataset.accept = String(!!ev.accept);
    if (ev.reason) {
      v.verdict.textContent = tr('It cannot take this offer: {reason}', { reason: ui.text.reason(ev.reason) });
      v.bar.hidden = true;
      v.factors.replaceChildren();
      return;
    }
    v.bar.hidden = false;
    v.verdict.textContent = ev.accept ? tr('Would accept: {score} of {threshold}', { score: ui.text.score(ev.score), threshold: ui.text.score(ev.threshold) })
      : tr('Would refuse: {score} of {threshold}', { score: ui.text.score(ev.score), threshold: ui.text.score(ev.threshold) });
    v.verdict.classList.toggle('yes', !!ev.accept);
    const scale = Math.max(1000, ev.threshold * 1.5, ev.score * 1.1);
    v.fill.style.width = `${Math.max(0, Math.min(100, (ev.score / scale) * 100))}%`;
    v.fill.classList.toggle('yes', !!ev.accept);
    v.mark.style.left = `${Math.min(100, (ev.threshold / scale) * 100)}%`;
    const base = ev.score - ev.factors.reduce((s, f) => s + f.delta, 0);
    const row = (label, args, delta, key) => {
      const r = el('div', `cq-dip-factor ${delta >= 0 ? 'pos' : 'neg'}`);
      r.dataset.label = key;
      r.dataset.delta = String(delta);
      r.append(dip.partsEl(ui.text.factor(label, args, p.to, true), 'cq-dip-factor-text'), el('span', 'cq-dip-factor-delta', ui.text.signed(delta)));
      return r;
    };
    v.factors.replaceChildren(row('base', null, base, 'base'), ...ev.factors.map((f) => row(f.label, f.args, f.delta, f.label)));
  }

  async function renderProposal() {
    if (!view) return;
    const v = view.prop;
    const p = proposal && proposal.to === dip.selected ? proposal : null;
    v.box.hidden = !p;
    if (!p) return;
    v.box.dataset.action = p.action;
    v.title.textContent = tr('Proposal to {nation}: {action}', { nation: game.nationName(p.to), action: ui.text.action(p.action) });
    v.terms.hidden = p.action !== 'offer-peace';
    if (p.action === 'offer-peace') {
      let info = { take: [], give: [], extra: [] };
      try { info = await game.query('peace', { to: p.to, provinces: [...p.take, ...p.give] }); } catch {}
      if (proposal !== p || !view) return;
      const ptsOf = new Map([...info.take, ...info.give, ...info.extra].map((x) => [x.id, x]));
      const chip = (side, id) => {
        const x = ptsOf.get(id) || { us: 0, them: 0 };
        const c = el('span', 'cq-dip-term');
        c.dataset.province = String(id);
        c.append(dip.partsEl([{ text: game.map.provinces[id]?.name || '?', province: id }]), el('span', 'cq-dip-pts', tr('{us} / {them} pts', { us: x.us, them: x.them })));
        const x2 = el('button', 'cq-icon-btn cq-dip-term-x');
        x2.append(ide.icon('closeSmall'));
        x2.title = tr('Take Out of the Terms');
        x2.onclick = () => toggleTerm(side, id);
        c.append(x2);
        return c;
      };
      const cand = (side, x) => {
        const b = el('button', 'cq-dip-cand');
        b.dataset.province = String(x.id);
        b.dataset.userText = '';
        b.textContent = `${game.map.provinces[x.id]?.name || '?'} (${x.us} / ${x.them})`;
        b.onclick = () => toggleTerm(side, x.id);
        return b;
      };
      v.takeChosen.replaceChildren(...p.take.map((id) => chip('take', id)));
      v.giveChosen.replaceChildren(...p.give.map((id) => chip('give', id)));
      const takeC = info.take.filter((x) => !p.take.includes(x.id));
      const giveC = info.give.filter((x) => !p.give.includes(x.id));
      v.takeCands.replaceChildren(...(takeC.length ? takeC.map((x) => cand('take', x)) : [el('span', 'cq-dip-note', tr('None.'))]));
      v.giveCands.replaceChildren(...(giveC.length ? giveC.map((x) => cand('give', x)) : [el('span', 'cq-dip-note', tr('None.'))]));
      const sum = (list, k) => list.reduce((s, id) => s + (ptsOf.get(id)?.[k] || 0), 0);
      v.totals.textContent = tr('Worth to us: {a} taken, {b} given. As it counts them: {c} and {d}.',
        { a: sum(p.take, 'us'), b: sum(p.give, 'us'), c: sum(p.take, 'them'), d: sum(p.give, 'them') });
    }
    schedulePreview();
  }

  async function sendProposal() {
    const p = proposal;
    if (!p) return;
    const preview = lastPreview;
    const r = await send(orderFor(p.action, p.to));
    if (!r.ok) return;
    sent.set(r.id, { to: p.to, action: p.action, preview });
    proposal = null;
    shell.toast(tr('Offer sent. {nation} answers on its next day.', { nation: game.nationName(p.to) }));
    renderProposal();
    renderOutbox();
  }
})();
