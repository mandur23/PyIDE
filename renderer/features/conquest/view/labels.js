// Nation names written across the land each nation controls, on the 2D overlay under the lines and markers. Placement
// is recomputed when control changes (update), never per frame: the land provinces of one controller are split into
// connected areas (land neighbours only); the area holding most of the nation's home land (its cores, weighed by area;
// the capital's area on a tie, the largest when none holds home land) carries the main label, and up to EXTRA others
// with at least EXTRA_SHARE of its size (colonies) carry one no larger than the home one. Home land, not the capital,
// decides: a war that cuts the capital off in a small pocket, or takes it, left the main name on that pocket (too small
// to draw) or on a colony larger than the homeland (France on West Africa). A label lies along the area's long axis (the area-weighted principal axis of its anchors, flat
// under FLAT and at most MAX_TILT), is sized to span LONG of that axis and no more than CROSS of the area's width, and
// gets letter spacing when the name is short for the length. On screen a name is at most MAX_PX tall (a great power's
// name zoomed in would otherwise be hundreds of pixels). The names fade out between FADE[0] and FADE[1] CSS pixels per
// texture pixel (zoomed in, where counters matter) and draw nothing below MIN_PX on screen. The overlay takes no
// pointer events, so names never intercept clicks. Each name is drawn once into a bitmap (font size in steps of a sixth
// of an octave, BITMAP_PX at most, per theme) and the frame only places bitmaps: writing 40 names with letter spacing
// every frame held the bench map at 20 fps. The bitmaps are ImageBitmaps (immutable) drawn with low smoothing: a
// canvas source drawn scaled with medium smoothing stalled the integrated GPU's frames by 100 ms.
// Conquest.view.labelLayer(map, fontOf) -> { setNames(names, capitals?, homes?), update(ctrl), labels, alpha(cam),
//   draw(g, cam, dpr) }. names: per nation index its shown name; capitals: per nation index its capital province;
//   homes: per nation index its home provinces (a list of ids; without one, every area counts as home);
//   ctrl: per province id the controller's index, -1 none. fontOf() -> the CSS font family the overlay writes in (the
//   app's own, which carries Hangul).
// Label = { nation, text, x, y (centre, texture px), angle (radians), size (font px in texture px), spacing (px between
// letters at size), main (the capital's area, else the largest) }.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const EXTRA = 2;
  const EXTRA_SHARE = 0.12;
  const FLAT = 0.1;
  const MAX_TILT = 0.6;
  const LONG = 0.62;
  const CROSS = 0.4;
  const MAX_PX = 44;
  const FADE = [1.1, 2.2];
  const MIN_PX = 7;
  const WEIGHT = 600;
  const BITMAP_PX = [12, 96];
  const KEEP = 400;

  view.labelLayer = (map, fontOf) => {
    const P = map.provinces;
    const MW = map.texture.width;
    const kmPerPx = 40075 / MW;
    const areaPx = (p) => Math.max(1, (p.area || 1) / (kmPerPx * kmPerPx));
    let names = [];
    let capitals = [];
    let homes = [];
    let ctrl = null;
    let labels = [];
    const measure = new OffscreenCanvas(4, 4).getContext('2d');
    const bitmaps = new Map();

    function areas(c) {
      const seen = new Uint8Array(P.length);
      const out = new Map();
      for (let id = 1; id < P.length; id++) {
        const n = c[id];
        if (seen[id] || n < 0 || !P[id] || P[id].sea) continue;
        const list = [];
        const stack = [id];
        seen[id] = 1;
        while (stack.length) {
          const q = stack.pop();
          list.push(q);
          for (const r of P[q].adj) if (!seen[r] && c[r] === n && P[r] && !P[r].sea) { seen[r] = 1; stack.push(r); }
        }
        (out.get(n) || out.set(n, []).get(n)).push(list);
      }
      return out;
    }

    // An area across the map's east-west seam (the Russian Far East) is placed with its western part moved a map width east.
    function place(nation, list, text, main) {
      const xs = list.map((id) => P[id].x);
      const wrap = Math.max(...xs) - Math.min(...xs) > MW / 2;
      const X = new Map(list.map((id) => [id, wrap && P[id].x < MW / 2 ? P[id].x + MW : P[id].x]));
      let w = 0, mx = 0, my = 0;
      for (const id of list) { const a = areaPx(P[id]); w += a; mx += X.get(id) * a; my += P[id].y * a; }
      mx /= w; my /= w;
      let sxx = 0, syy = 0, sxy = 0;
      for (const id of list) { const a = areaPx(P[id]); const dx = X.get(id) - mx; const dy = P[id].y - my; sxx += a * dx * dx; syy += a * dy * dy; sxy += a * dx * dy; }
      let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      if (Math.abs(angle) < FLAT) angle = 0;
      angle = Math.max(-MAX_TILT, Math.min(MAX_TILT, angle));
      const ux = Math.cos(angle), uy = Math.sin(angle);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const id of list) {
        const r = Math.sqrt(areaPx(P[id])) / 2;
        const dx = X.get(id) - mx, dy = P[id].y - my;
        const u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
        u0 = Math.min(u0, u - r); u1 = Math.max(u1, u + r); v0 = Math.min(v0, v - r); v1 = Math.max(v1, v + r);
      }
      const len = u1 - u0;
      const cross = v1 - v0;
      const uc = (u0 + u1) / 2;
      measure.font = `${WEIGHT} 100px ${fontOf()}`;
      const w100 = Math.max(1, measure.measureText(text).width);
      let size = Math.min((LONG * len) / (w100 / 100), CROSS * cross);
      if (!main) size *= 0.8;
      const room = LONG * len - (w100 / 100) * size;
      const letters = [...text].length;
      const spacing = letters > 1 && room > 0 ? Math.min(size * 0.9, room / (letters - 1)) : 0;
      return { nation, text, x: (mx + uc * ux) % MW, y: my + uc * uy, angle, size, spacing, main, weight: w };
    }

    function update(c) {
      ctrl = c || ctrl;
      if (!ctrl || !names.length) { labels = []; return; }
      const out = [];
      for (const [nation, lists] of [...areas(ctrl)].sort((a, b) => a[0] - b[0])) {
        const text = names[nation];
        if (!text) continue;
        const home = homes[nation];
        const weighed = lists.map((l) => ({ l, w: l.reduce((s, id) => s + areaPx(P[id]), 0), h: home ? l.reduce((s, id) => s + (home.has(id) ? areaPx(P[id]) : 0), 0) : 0, cap: l.includes(capitals[nation]) }))
          .sort((a, b) => b.w - a.w || a.l[0] - b.l[0]);
        let at = 0;
        weighed.forEach((a, i) => { const b = weighed[at]; if (a.h > b.h || (a.h === b.h && a.cap && !b.cap)) at = i; });
        const [main] = weighed.splice(at, 1);
        const first = place(nation, main.l, text, true);
        out.push(first);
        for (const { l, w } of weighed.slice(0, EXTRA)) {
          if (w < EXTRA_SHARE * main.w) continue;
          const extra = place(nation, l, text, false);
          const k = Math.min(1, first.size / extra.size);
          out.push({ ...extra, size: extra.size * k, spacing: extra.spacing * k });
        }
      }
      labels = out;
      for (const l of labels) bitmapOf(l, dark(), devicePixelRatio || 1);
    }

    function bitmapOf(l, theme, dpr) {
      const want = Math.max(BITMAP_PX[0], Math.min(BITMAP_PX[1], MAX_PX * dpr, l.size * FADE[0] * dpr));
      const px = Math.round(2 ** (Math.round(Math.log2(want) * 6) / 6));
      const sp = Math.round((l.spacing / l.size) * 10) / 10;
      const key = `${l.text}|${px}|${sp}|${theme}`;
      let b = bitmaps.get(key);
      if (b) return b;
      if (bitmaps.size > KEEP) bitmaps.clear();
      const font = `${WEIGHT} ${px}px ${fontOf()}`;
      measure.font = font;
      measure.letterSpacing = `${sp * px}px`;
      const pad = Math.ceil(px / 6);
      const w = Math.ceil(measure.measureText(l.text).width - sp * px) + 2 * pad;
      const h = Math.ceil(px * 1.35) + 2 * pad;
      const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
      const c = canvas.getContext('2d');
      c.font = font;
      c.letterSpacing = `${sp * px}px`;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';
      c.lineWidth = Math.max(1.5, px / 9);
      c.strokeStyle = theme ? 'rgba(10,10,12,.5)' : 'rgba(255,255,255,.55)';
      c.strokeText(l.text, pad, h / 2);
      c.fillStyle = theme ? 'rgba(238,234,222,.85)' : 'rgba(28,26,22,.82)';
      c.fillText(l.text, pad, h / 2);
      b = { canvas: canvas.transferToImageBitmap(), w, h, px };
      bitmaps.set(key, b);
      return b;
    }
    const alpha = (cam) => Math.max(0, Math.min(1, (FADE[1] - cam.scale) / (FADE[1] - FADE[0])));
    const dark = () => document.documentElement.dataset.theme !== 'light';

    return {
      setNames(list, caps, homeLists) {
        names = Array.isArray(list) ? list.map((n) => String(n || '')) : [];
        capitals = Array.isArray(caps) ? caps : [];
        homes = Array.isArray(homeLists) ? homeLists.map((h) => (Array.isArray(h) && h.length ? new Set(h) : null)) : [];
        update(null);
      },
      update,
      get labels() { return labels; },
      alpha,
      draw(g, cam, dpr) {
        const a = alpha(cam);
        if (!a || !labels.length) return;
        const theme = dark();
        g.save();
        g.globalAlpha = a;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'low';
        for (const l of labels) {
          const px = Math.min(MAX_PX, l.size * cam.scale);
          if (px < MIN_PX) continue;
          const [sx, sy] = cam.toScreen(l.x, l.y);
          const b = bitmapOf(l, theme, dpr);
          const k = (px * dpr) / b.px;
          const reach = (Math.max(b.w, b.h) * k) / dpr;
          if (sx < -reach || sy < -reach || sx > cam.w + reach || sy > cam.h + reach) continue;
          g.setTransform(k * Math.cos(l.angle), k * Math.sin(l.angle), -k * Math.sin(l.angle), k * Math.cos(l.angle), sx * dpr, sy * dpr);
          g.drawImage(b.canvas, -b.w / 2, -b.h / 2);
        }
        g.restore();
      },
    };
  };
})();
