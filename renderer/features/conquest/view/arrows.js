// Border lines, front lines, offensive arrows and battle markers over the map. A border line follows real province
// edges (borders.js) and is drawn as a dark casing under its colour; a front through the anchors of its provinces is a
// dashed line (a front with no edge to draw along, and the line being drawn); an offensive a smoothed wide arrow with a
// head at its last province; a battle marker a disc above the province's counters, coloured from losing (red) through
// even (sand) to winning (green) for the player's side, with the odds as a number and a second channel besides colour:
// a triangle pointing up over the disc when the player's side is winning (odds >= EVEN[1]), down under it when losing
// (odds <= EVEN[0]), none when even. A battle the player is not in is a smaller grey disc with the attacker's odds.
// Conquest.view.lineLayer() -> { setBorders([{ paths: [Float32Array], color, width?, box }]), setFronts([{ provinces,
//   color, width? }]), setArrows([{ path, color, width?, dashed? }]), setMarkers([Marker]), markers, markerAt(sx, sy,
//   cam, map), draw(g, cam, map, dpr) }. width scales the line (1 = the default); paths are texture-pixel polylines and
//   box [x0, y0, x1, y1] their extent. Marker = { prov, odds 0..1000, mine (the player's camp fights: odds are its
//   side's; else they are the attacker's) }.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const EVEN = [450, 550];
  const LOSE = [208, 74, 60];
  const MID = [201, 178, 106];
  const WIN = [86, 168, 92];
  const GREY = '#8d8a84';
  const R = 10;
  const R_OTHER = 7;
  // The marker's centre above the anchor: clear of a counter (COUNTER.H / 2 + PAD) and of its own triangle.
  const LIFT = 26;
  // Zoomed out a border line is drawn from a path simplified to COARSE_EPS map pixels and without its casing: 600 pairs
  // at full detail with casing and round joins, with names and markers, held the bench map at 35 fps.
  const COARSE_EPS = 3;
  const COARSE_BELOW = 0.8;
  const CASING_AT = 0.5;

  const points = (ids, cam, map, dpr) => ids.map((id) => map.provinces[id]).filter(Boolean)
    .map((p) => cam.toScreen(p.x, p.y).map((v) => v * dpr));

  // Through every point, with Catmull-Rom tangents turned into Bezier control points.
  function smooth(g, pts) {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]];
      g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
  }

  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  view.oddsColor = (odds) => {
    const t = Math.max(0, Math.min(1, odds / 1000));
    const c = t < 0.5 ? mix(LOSE, MID, t * 2) : mix(MID, WIN, (t - 0.5) * 2);
    return `rgb(${c.join(',')})`;
  };
  view.oddsTrend = (odds) => (odds >= EVEN[1] ? 'up' : odds <= EVEN[0] ? 'down' : 'even');

  view.lineLayer = () => {
    let borders = [];
    let fronts = [];
    let arrows = [];
    let markers = [];
    const valid = (list, key) => (Array.isArray(list) ? list.filter((x) => x && Array.isArray(x[key]) && x[key].length >= 2) : []);
    const markerPoint = (m, cam, map) => {
      const p = map.provinces[m.prov];
      const [x, y] = cam.toScreen(p.x + 0.5, p.y + 0.5);
      return [x, y - LIFT];
    };
    return {
      setBorders(list) {
        borders = (Array.isArray(list) ? list.filter((b) => b && b.paths?.length) : []).map((b) => {
          const shape = new Path2D();
          const coarse = new Path2D();
          for (const path of b.paths) {
            for (let i = 0; i < path.length; i += 2) if (i) shape.lineTo(path[i], path[i + 1]); else shape.moveTo(path[i], path[i + 1]);
            const c = view.simplifyLine(path, COARSE_EPS);
            for (let i = 0; i < c.length; i += 2) if (i) coarse.lineTo(c[i], c[i + 1]); else coarse.moveTo(c[i], c[i + 1]);
          }
          return { ...b, shape, coarse };
        });
      },
      setFronts(list) { fronts = valid(list, 'provinces'); },
      setArrows(list) { arrows = valid(list, 'path'); },
      setMarkers(list) {
        markers = Array.isArray(list) ? list.filter((m) => m && m.prov > 0) : [];
        for (const m of markers) markerBitmap(m, devicePixelRatio || 1);
      },
      get markers() { return markers; },
      get count() { return borders.length + fronts.length + arrows.length + markers.length; },
      // The marker under a CSS point of the map, the nearest when several overlap; null when none.
      markerAt(sx, sy, cam, map) {
        let best = null;
        let bd = Infinity;
        for (const m of markers) {
          if (!map.provinces[m.prov]) continue;
          const [x, y] = markerPoint(m, cam, map);
          const d = Math.hypot(sx - x, sy - y);
          if (d <= (m.mine ? R : R_OTHER) + 2 && d < bd) { bd = d; best = m; }
        }
        return best;
      },
      markerPoint,
      draw(g, cam, map, dpr) {
        g.save();
        g.lineJoin = 'round';
        g.lineCap = 'round';
        const W = g.canvas.width;
        const H = g.canvas.height;
        for (const b of borders) {
          if (b.box) {
            const [x0, y0] = cam.toScreen(b.box[0], b.box[1]);
            const [x1, y1] = cam.toScreen(b.box[2], b.box[3]);
            if (x1 * dpr < -10 || y1 * dpr < -10 || x0 * dpr > W + 10 || y0 * dpr > H + 10) continue;
          }
          const w = b.width || 1;
          const k = cam.scale * dpr;
          const shape = cam.scale < COARSE_BELOW ? b.coarse : b.shape;
          g.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
          g.lineJoin = 'bevel';
          if (b.casing !== false && cam.scale >= CASING_AT) {
            g.lineWidth = (2 + 2.5 * w) / cam.scale;
            g.strokeStyle = 'rgba(0,0,0,.55)';
            g.stroke(shape);
          }
          g.lineWidth = (cam.scale >= CASING_AT ? 2.5 : 2) * w / cam.scale;
          g.strokeStyle = b.color || '#ffffff';
          g.stroke(shape);
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.lineJoin = 'round';
        for (const f of fronts) {
          const pts = points(f.provinces, cam, map, dpr);
          if (pts.length < 2) continue;
          const w = f.width || 1;
          g.beginPath();
          smooth(g, pts);
          g.setLineDash([7 * dpr * w, 5 * dpr * w]);
          g.lineWidth = 3.5 * dpr * w;
          g.strokeStyle = 'rgba(0,0,0,.55)';
          g.stroke();
          g.lineWidth = 2 * dpr * w;
          g.strokeStyle = f.color || '#ffffff';
          g.stroke();
        }
        g.setLineDash([]);
        for (const a of arrows) {
          const pts = points(a.path, cam, map, dpr);
          if (pts.length < 2) continue;
          const w = a.width || 1;
          const [ex, ey] = pts[pts.length - 1];
          const [px, py] = pts[pts.length - 2];
          const len = Math.hypot(ex - px, ey - py) || 1;
          const ux = (ex - px) / len;
          const uy = (ey - py) / len;
          const head = 16 * dpr * Math.max(0.6, w);
          const body = pts.slice(0, -1).concat([[ex - ux * head * 0.8, ey - uy * head * 0.8]]);
          g.setLineDash(a.dashed ? [9 * dpr * w, 6 * dpr * w] : []);
          g.beginPath();
          smooth(g, body);
          g.lineWidth = 9 * dpr * w;
          g.strokeStyle = 'rgba(0,0,0,.45)';
          g.stroke();
          g.lineWidth = 6 * dpr * w;
          g.strokeStyle = a.color || '#d33c2f';
          g.stroke();
          g.setLineDash([]);
          g.beginPath();
          g.moveTo(ex, ey);
          g.lineTo(ex - ux * head - uy * head * 0.6, ey - uy * head + ux * head * 0.6);
          g.lineTo(ex - ux * head + uy * head * 0.6, ey - uy * head - ux * head * 0.6);
          g.closePath();
          g.fillStyle = a.color || '#d33c2f';
          g.fill();
          g.lineWidth = 1.5 * dpr;
          g.strokeStyle = 'rgba(0,0,0,.55)';
          g.stroke();
        }
        for (const m of markers) {
          if (!map.provinces[m.prov]) continue;
          const [cx, cy] = markerPoint(m, cam, map);
          const b = markerBitmap(m, dpr);
          const x = Math.round(cx * dpr - b.width / 2);
          const y = Math.round(cy * dpr - b.height / 2);
          if (x < -b.width || y < -b.height || x > W || y > H) continue;
          g.drawImage(b, x, y);
        }
        g.restore();
      },
    };
  };

  // A marker drawn once per odds in whole percent, side and pixel ratio; frames only place it.
  const markerCache = new Map();
  function markerBitmap(m, dpr) {
    const odds = Math.round(Math.max(0, Math.min(1000, m.odds | 0)) / 10) * 10;
    const key = `${odds}|${!!m.mine}|${dpr}`;
    let c = markerCache.get(key);
    if (c) return c;
    const size = Math.ceil((2 * R + 18) * dpr);
    c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const x = size / 2;
    const y = size / 2;
    const r = (m.mine ? R : R_OTHER) * dpr;
    const fill = m.mine ? view.oddsColor(odds) : GREY;
    const trend = m.mine ? view.oddsTrend(odds) : 'even';
    if (trend !== 'even') {
      const s = trend === 'up' ? -1 : 1;
      const tip = y + s * (r + 7 * dpr);
      const base = y + s * (r - 1 * dpr);
      g.beginPath();
      g.moveTo(x, tip);
      g.lineTo(x - 6 * dpr, base);
      g.lineTo(x + 6 * dpr, base);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = 'rgba(0,0,0,.75)';
      g.stroke();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = 'rgba(0,0,0,.8)';
    g.stroke();
    g.font = `700 ${(m.mine ? 10 : 8) * dpr}px system-ui, sans-serif`;
    g.fillStyle = '#111';
    g.fillText(String(Math.round(odds / 10)), x, y + 0.5 * dpr);
    const image = c.transferToImageBitmap();
    markerCache.set(key, image);
    return image;
  }
})();
