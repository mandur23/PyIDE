// The control API's tools for graphic clips (docs/cut-ai-control.md, graphic.js): motion graphics an AI builds from
// layers (shapes, SVG paths, text, groups, particles) and animates with set_keyframes on layers.<id>.<field>.
(function (part) {
  if (typeof module === 'object' && module.exports) module.exports = part;
  else globalThis.Cut.control.extend(part);
})((K) => {
  const { tool, refuse, need, M, C, num, str, list, obj, context, timeIn, ticks, clipOf, trackOf, run, atomic } = K;
  const G = () => need('graphic');

  // The layer as the model reads it: one guide to every field (graphic.validate checks them, with ranges, and its
  // refusal says what is wrong), kept short because every tool's schema goes to the model with each request.
  const GUIDE = "A layer: {id, kind, ...fields}. By kind: rect size [w, h], radius; ellipse size; polygon points, radius; star points, radius, innerRadius; line from [x, y], to [x, y]; path d (SVG path data, no A arcs); text text (\"{value}\" shows value), font, fontSize, weight, italic, align, lineHeight, letterSpacing, value, decimals, reveal (0..1); group (others name it as parent); particles count, seed, emit (stream or burst), emitter [w, h], direction (degrees, 0 up), spread, speed (px/s), speedVariation, gravity [x, y] (px/s²), life (s), particleSize, particleSizeEnd, fill, fillEnd, opacityEnd, particleShape (circle or square), spin. Paint: fill (\"#rrggbb\", \"#rrggbbaa\" or null), gradient ({type: linear or radial, from: [x, y], to: [x, y], stops: [[0, color], [1, color]]}), stroke, strokeWidth, cap, join, dash ([dash, gap]), trimStart, trimEnd, trimOffset (% of the outline). Every layer: name, parent (a group earlier in the list), visible, position [x, y], anchor [x, y] (pivot), scale [x %, y %], rotation (degrees), opacity (%), blend (normal, add, screen, multiply, overlay...), blur, shadowColor, shadowBlur, shadowOffset, repeatCount (copies), repeatOffset [x, y], repeatRotation, repeatScale [x %, y %] (per copy), repeatOpacity (last copy %).";
  const LAYER = { type: 'object', description: GUIDE, properties: { id: { type: 'string', maxLength: 40, description: 'Unique id; keyframes name it.' }, kind: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'text', 'group', 'particles'], description: 'Kind.' } }, required: ['kind'] };
  const LOOSE = (description, required = []) => ({ type: 'object', description, required });

  const problems = (layers) => G().validate(layers);
  // The layers with an id each: given ids stay, the others get g<n> not used yet.
  const withIds = (layers, taken = []) => {
    const used = new Set([...taken, ...layers.map((l) => l.id).filter(Boolean)]);
    let n = 0;
    return layers.map((l) => {
      if (l.id) return { ...l };
      let id;
      do id = `g${++n}`; while (used.has(id));
      used.add(id);
      return { ...l, id };
    });
  };
  const graphicClip = (c, id) => {
    const clip = clipOf(c, id);
    if (clip.source?.generator !== 'graphic') refuse(`${clip.id} is not a graphic clip (add_graphic makes one).`);
    return clip;
  };

  tool('add_graphic', 'edit', 'Add a graphic',
    'Adds a motion graphic clip drawn from layers (shapes, paths, text, groups, particles) on a transparent background, at a time for duration seconds. Pixels from the frame\'s center, y down; the first layer at the bottom. Animate with set_keyframes on "layers.<id>.<field>": trimEnd 0 to 100 draws a line on, value counts up a {value} text, scale [0, 0] to [100, 100] pops in. Check with get_frame.',
    obj({ at: num('Start (s).', { minimum: 0 }), duration: num('Seconds.', { minimum: 0.04, maximum: 3600 }), track: str('A video track (default: a free one).'), name: str('Name.', { maxLength: 100 }), layers: list(LAYER, 'The layers, bottom first.', { minItems: 1, maxItems: 200 }) }, ['at', 'layers']),
    (c, a) => {
      const layers = withIds(a.layers);
      const bad = problems(layers);
      if (bad.length) refuse(`The graphic is not valid: ${bad.join('; ')}.`);
      const at = need('time').snap(timeIn(c, a.at, 'at'), c.seq.fps);
      const d = Math.max(c.f, a.duration != null ? Math.round(ticks(c, a.duration) / c.f) * c.f : c.project.settings.stillDuration);
      let track = a.track ? trackOf(c, a.track, { kind: 'video', unlocked: true }).id : null;
      const id = atomic(c, 'Add Graphic', () => {
        if (!track) {
          const vids = c.seq.tracks.filter((t) => t.kind === 'video');
          const busy = (tid) => c.seq.clips.some((x) => x.track === tid && x.start < at + d && M().clipEnd(x) > at);
          let top = -1;
          vids.forEach((t, i) => { if (busy(t.id)) top = i; });
          track = vids.slice(top + 1).find((t) => !t.locked)?.id || run(c, C().addTrack(c.seq.id, 'video')).id;
        }
        return run(c, C().addGenerated(c.seq.id, { track, at, duration: d, name: a.name || 'Graphic', source: { generator: 'graphic', layers } })).id;
      });
      const clip = c.seq.clips.find((x) => x.id === id);
      return { edit: { at }, clip: id, track, layers: clip.source.layers.map((l) => l.id) };
    }, (a) => ['Add a graphic at {at} s ({n} layers)', { at: a.at, n: a.layers?.length ?? 0 }]);

  tool('set_graphic', 'edit', 'Change a graphic',
    'Changes a graphic clip\'s layers as one undo step: layers replaces them all, or update (fields by id), add and remove.',
    obj({
      clip_id: str('The graphic clip.'),
      layers: list(LOOSE('A layer as in add_graphic.', ['kind']), 'All layers (replaces them).', { minItems: 1, maxItems: 200 }),
      update: list(LOOSE('id and the fields to set (not kind).', ['id']), 'Layers to change.', { maxItems: 200 }),
      add: list(LOOSE('A layer, and after: the layer it goes above (default: on top).', ['kind']), 'Layers to add.', { maxItems: 200 }),
      remove: list(str('A layer id.', { maxLength: 40 }), 'Layers to remove.', { maxItems: 200 }),
    }, ['clip_id']),
    (c0, a) => {
      const c = context(c0, a);
      const clip = graphicClip(c, a.clip_id);
      if (a.layers && (a.update || a.add || a.remove)) refuse('Give layers alone, or update, add and remove.');
      if (!a.layers && !a.update?.length && !a.add?.length && !a.remove?.length) refuse('Nothing to change: give layers, update, add or remove.');
      // the layers as they will be, checked whole before anything changes
      let next = clip.source.layers.map((l) => ({ ...l }));
      // new layers without an id never take an id the clip has now: its keyframes are not theirs
      if (a.layers) next = withIds(a.layers, clip.source.layers.map((l) => l.id));
      for (const id of a.remove || []) {
        if (!next.some((l) => l.id === id)) refuse(`${clip.id} has no layer ${id}. Layers: ${next.map((l) => l.id).join(', ')}.`);
        next = next.filter((l) => l.id !== id);
      }
      const added = [];
      for (const [i, x] of (a.add || []).entries()) {
        const { after, ...given } = x;
        const [layer] = withIds([given], [...next.map((l) => l.id), ...clip.source.layers.map((l) => l.id)]);
        const id = layer.id;
        const at = after ? next.findIndex((l) => l.id === after) : next.length - 1;
        if (after && at < 0) refuse(`add[${i}].after: ${clip.id} has no layer ${after}.`);
        next.splice(at + 1, 0, layer);
        added.push(id);
      }
      for (const u of a.update || []) {
        const l = next.find((x) => x.id === u.id);
        if (!l) refuse(`${clip.id} has no layer ${u.id}. Layers: ${next.map((x) => x.id).join(', ')}.`);
        if (u.kind !== undefined && u.kind !== l.kind) refuse(`Layer ${u.id} is a ${l.kind}; a layer keeps its kind (remove it and add another).`);
        Object.assign(l, u);
      }
      const bad = problems(next);
      if (bad.length) refuse(`The graphic would not be valid: ${bad.join('; ')}.`);
      if (!next.length) refuse('A graphic keeps one layer at least; delete_clips removes the clip.');
      // the whole list in one command, checked as a whole: removes, adds and updates in one call never meet a state
      // between them (a group removed with its children, a child moved to a group added in the same call)
      atomic(c, 'Edit Graphic', () => run(c, C().setGenerator(c.seq.id, clip.id, { layers: next })));
      return { edit: { at: Math.max(clip.start, Math.min(c.app.t, M().clipEnd(clip) - c.f)) }, layers: clip.source.layers.map((l) => l.id), ...(added.length ? { added } : {}) };
    }, (a) => ['Change graphic {clip}', { clip: a.clip_id }]);

  // get_clip's view of a graphic: each layer's fields that differ from the defaults.
  K.graphicLayers = (clip) => clip.source.layers.map((l) => G().compact(l));
  // set_keyframes' check of a graphic layer's field: the value, or a refusal.
  K.graphicKey = (clip, layerId, field, v, at) => {
    const l = clip.source.layers.find((x) => x.id === layerId);
    if (!G().ANIMATED.has(field) || !G().fieldsOf(l.kind).includes(field)) {
      const can = G().fieldsOf(l.kind).filter((f) => G().ANIMATED.has(f));
      refuse(`A ${l.kind} layer animates ${can.join(', ')}; not ${field}.`);
    }
    const e = G().checkValue(field, v);
    if (e) refuse(`${at} ${e}.`);
    // colors kept as #rrggbbaa, so a keyframe with alpha and one without still blend into each other
    return typeof v === 'string' && v.length === 7 ? `${v}ff` : v;
  };
});
