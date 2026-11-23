// Division counters over the map, drawn by the map's WebGL context as one instanced draw: a NATO-style infantry box in
// the nation's colour at the province's anchor, with the number of divisions stacked there. The parts that do not
// depend on the nation (outline, symbol, number) come from an atlas with one cell per count, drawn once per device
// pixel ratio; the box takes the instance's colour. A 2D canvas overlay with one drawImage per counter held the map
// at 46 fps with 2,000 counters on screen; this draws them in under a millisecond (verify/conquest-view-bench.mjs).
// Conquest.view.unitLayer(map) -> { set(units), clusters(scale), visible(cam), build(gl), draw(gl, frame) } with units
// [{ prov, nation, count, color, ring?, str?, org?, key?, selected?, dx?, dy? }]: ring is the colour of the frame around
// the box (whose side it is, or the selection), str 0..1 the strength bar along the box's bottom edge and org 0..1 the
// organisation bar just above it (blue; none when absent), dx, dy an offset in CSS pixels from the anchor (stacks of
// several sides in one province). build and draw are the renderer's layer hooks (gl.js).
// Units with the same key merge when zoomed out so far that their boxes would overlap. Cluster = { lead, members
// (indexes into the set list, lead first), prov, dx, dy, count (the sum), str, org (the means weighted by count),
// color, ring }: the lead is the largest stack and keeps its place; the others join it when they lie in provinces
// reached from the lead's over neighbours inside the window around it and their boxes would overlap its box at the
// zoom bucket's scale. Buckets are quarter octaves of the camera scale, so clustering depends on the zoom only (stable
// while panning), is recomputed only when the bucket or the units change, and the same camera always gives the same
// clusters (units taken largest first, then by province and order). A cluster's ring is that of its first selected
// member, else its lead's. Conquest.view.COUNTER = { W, H, PAD } is the box size and the frame width in CSS pixels.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const W = 26;
  const H = 17;
  const PAD = 2;
  const STRIDE = 13;
  view.COUNTER = { W, H, PAD };
  const COLS = 10;
  const CELLS = 100; // counts 1..99, then '99+'

  const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aCell;
layout(location = 3) in vec3 aRing;
layout(location = 4) in float aStr;
layout(location = 5) in vec2 aOff;
layout(location = 6) in float aOrg;
uniform float uDpr;
out float vOrg;
out vec3 vRing;
out float vStr;
uniform vec2 uOrigin;
uniform float uTexPerPx;
uniform vec2 uView;
uniform vec2 uCell;
uniform vec2 uAtlas;
out vec2 vLocal;
out vec2 vUv;
out vec3 vColor;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = floor((aPos - uOrigin) / uTexPerPx + aOff * uDpr - uCell * 0.5) + corner * uCell;
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
  vec2 cell = vec2(mod(aCell, ${COLS}.0), floor(aCell / ${COLS}.0));
  vUv = (cell * uCell + corner * uCell) / uAtlas;
  vLocal = corner * uCell;
  vColor = aColor;
  vRing = aRing;
  vStr = aStr;
  vOrg = aOrg;
}`;
  const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlasTex;
uniform vec4 uBox;
uniform float uBar;
in vec2 vLocal;
in vec2 vUv;
in vec3 vColor;
in vec3 vRing;
in float vStr;
in float vOrg;
out vec4 outColor;
void main() {
  vec4 a = texture(uAtlasTex, vUv);
  bool inBox = vLocal.x >= uBox.x && vLocal.y >= uBox.y && vLocal.x < uBox.z && vLocal.y < uBox.w;
  if (!inBox) { outColor = vec4(vRing, 1.0); return; }
  vec3 c = mix(vColor, a.rgb, a.a);
  float f = (vLocal.x - uBox.x) / (uBox.z - uBox.x);
  if (vStr >= 0.0 && vLocal.y >= uBox.w - uBar) {
    vec3 bar = vStr > 0.66 ? vec3(0.45, 0.85, 0.35) : vStr > 0.33 ? vec3(0.95, 0.75, 0.25) : vec3(0.95, 0.3, 0.25);
    c = f <= vStr ? bar : vec3(0.08);
  } else if (vOrg >= 0.0 && vLocal.y >= uBox.w - 2.0 * uBar) {
    c = f <= vOrg ? vec3(0.42, 0.68, 0.98) : vec3(0.08);
  }
  outColor = vec4(c, 1.0);
}`;

  function atlasCanvas(dpr) {
    const cw = Math.ceil((W + 2 * PAD) * dpr);
    const ch = Math.ceil((H + 2 * PAD) * dpr);
    const c = new OffscreenCanvas(cw * COLS, ch * Math.ceil(CELLS / COLS));
    const g = c.getContext('2d');
    for (let i = 0; i < CELLS; i++) {
      g.save();
      g.translate((i % COLS) * cw, Math.floor(i / COLS) * ch);
      g.scale(dpr, dpr);
      g.translate(PAD, PAD);
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(0,0,0,.85)';
      g.strokeRect(0.5, 0.5, W - 1, H - 1);
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.fillRect(3, 3, 12, H - 6);
      g.strokeStyle = 'rgba(0,0,0,.8)';
      g.beginPath();
      g.moveTo(3, 3); g.lineTo(15, H - 3);
      g.moveTo(15, 3); g.lineTo(3, H - 3);
      g.stroke();
      g.font = '600 10px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 2.5;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.fillStyle = '#fff';
      const label = i === CELLS - 1 ? '99+' : String(i + 1);
      g.strokeText(label, 20.5, H / 2 + 0.5);
      g.fillText(label, 20.5, H / 2 + 0.5);
      g.restore();
    }
    return { canvas: c, cw, ch };
  }

  const bucketOf = (scale) => Math.round(Math.log2(Math.max(1e-6, scale)) * 4);
  const share = (v) => (v === undefined || v === null ? -1 : Math.max(0, Math.min(1, v)));

  view.unitLayer = (map) => {
    const P = map.provinces;
    let units = [];
    let byProv = new Map();
    let clusters = [];
    let bucket = NaN;
    let gl = null;
    let res = null;
    let dirty = true;
    let atlasDpr = 0;
    const hexCache = new Map();
    const hex = (s) => {
      let v = hexCache.get(s);
      if (!v) { v = [1, 3, 5].map((i) => (parseInt(String(s || '#888888').slice(i, i + 2), 16) || 0) / 255); hexCache.set(s, v); }
      return v;
    };

    function recluster(b) {
      const s = 2 ** (b / 4);
      const fw = W + 2 * PAD;
      const fh = H + 2 * PAD;
      const order = units.map((_, i) => i).sort((a, c) => units[c].count - units[a].count || units[a].prov - units[c].prov || a - c);
      const taken = new Uint8Array(units.length);
      const out = [];
      for (const i of order) {
        if (taken[i]) continue;
        taken[i] = 1;
        const u = units[i];
        const members = [i];
        if (u.key !== undefined && u.key !== null) {
          const x0 = P[u.prov].x * s + (u.dx || 0);
          const y0 = P[u.prov].y * s + (u.dy || 0);
          const seen = new Set([u.prov]);
          const stack = [u.prov];
          while (stack.length) {
            const q = stack.pop();
            for (const j of byProv.get(q) || []) {
              const v = units[j];
              if (taken[j] || v.key !== u.key) continue;
              if (Math.abs(P[v.prov].x * s + (v.dx || 0) - x0) < fw && Math.abs(P[v.prov].y * s + (v.dy || 0) - y0) < fh) { taken[j] = 1; members.push(j); }
            }
            for (const r of P[q].adj || []) {
              if (seen.has(r) || !P[r]) continue;
              seen.add(r);
              if (Math.abs(P[r].x * s - x0) < 1.5 * fw && Math.abs(P[r].y * s - y0) < 1.5 * fh) stack.push(r);
            }
          }
        }
        let count = 0, str = 0, org = 0, strN = 0, orgN = 0;
        for (const j of members) {
          const m = units[j];
          count += m.count;
          if (share(m.str) >= 0) { str += share(m.str) * m.count; strN += m.count; }
          if (share(m.org) >= 0) { org += share(m.org) * m.count; orgN += m.count; }
        }
        const hot = members.find((j) => units[j].selected);
        out.push({ lead: i, members, prov: u.prov, dx: u.dx || 0, dy: u.dy || 0, count, str: strN ? str / strN : null, org: orgN ? org / orgN : null,
          color: u.color, ring: units[hot ?? i].ring });
      }
      clusters = out;
      bucket = b;
      dirty = true;
    }
    const clustersAt = (scale) => {
      const b = bucketOf(scale);
      if (b !== bucket) recluster(b);
      return clusters;
    };

    function upload() {
      const data = new Float32Array(clusters.length * STRIDE);
      clusters.forEach((u, i) => {
        const p = map.provinces[u.prov];
        const o = i * STRIDE;
        const c = hex(u.color);
        const r = hex(u.ring || '#000000');
        data[o] = p.x + 0.5; data[o + 1] = p.y + 0.5;
        data[o + 2] = c[0]; data[o + 3] = c[1]; data[o + 4] = c[2];
        data[o + 5] = Math.min(u.count, CELLS) - 1;
        data[o + 6] = r[0]; data[o + 7] = r[1]; data[o + 8] = r[2];
        data[o + 9] = share(u.str);
        data[o + 10] = u.dx; data[o + 11] = u.dy;
        data[o + 12] = share(u.org);
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, res.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      dirty = false;
    }
    function atlas(dpr) {
      const a = atlasCanvas(dpr);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, res.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, a.canvas);
      res.cell = [a.cw, a.ch];
      res.size = [a.canvas.width, a.canvas.height];
      atlasDpr = dpr;
    }

    return {
      set(list) {
        units = Array.isArray(list) ? list.filter((u) => u && map.provinces[u.prov] && u.count > 0) : [];
        byProv = new Map();
        units.forEach((u, i) => (byProv.get(u.prov) || byProv.set(u.prov, []).get(u.prov)).push(i));
        bucket = NaN;
        dirty = true;
      },
      get count() { return units.length; },
      get list() { return units; },
      clusters: clustersAt,
      visible(cam) {
        let n = 0;
        for (const u of clustersAt(cam.scale)) {
          const p = map.provinces[u.prov];
          const [x0, y0] = cam.toScreen(p.x, p.y);
          const x = x0 + (u.dx || 0);
          const y = y0 + (u.dy || 0);
          if (x > -W && y > -H && x < cam.w + W && y < cam.h + H) n++;
        }
        return n;
      },
      build(g, compile) {
        gl = g;
        const prog = compile(VERT, FRAG);
        const u = Object.fromEntries(['uOrigin', 'uTexPerPx', 'uView', 'uCell', 'uAtlas', 'uAtlasTex', 'uBox', 'uDpr', 'uBar'].map((n) => [n, gl.getUniformLocation(prog, n)]));
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(0);
        const attrs = [[0, 2, 0], [1, 3, 2], [2, 1, 5], [3, 3, 6], [4, 1, 9], [5, 2, 10], [6, 1, 12]];
        for (const [loc, size, at] of attrs) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, at * 4);
          gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindVertexArray(null);
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        res = { prog, u, vao, buf, tex, cell: [1, 1], size: [1, 1] };
        dirty = true;
        atlas(devicePixelRatio || 1);
        // ANGLE compiles a program for Direct3D at its first draw (about 150 ms here): one hidden instance now, under
        // the map that the next frame draws over the whole canvas, keeps that off the first frame with counters.
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(STRIDE), gl.STATIC_DRAW);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        gl.bindVertexArray(null);
      },
      draw(g, f) {
        if (!units.length || !res) return;
        clustersAt(1 / (f.texPerPx * f.dpr));
        if (atlasDpr !== f.dpr) atlas(f.dpr);
        if (dirty) upload();
        const { u } = res;
        gl.useProgram(res.prog);
        gl.bindVertexArray(res.vao);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, res.tex);
        gl.uniform1i(u.uAtlasTex, 3);
        gl.uniform2f(u.uOrigin, f.x, f.y);
        gl.uniform1f(u.uTexPerPx, f.texPerPx);
        gl.uniform2f(u.uView, f.width, f.height);
        gl.uniform2f(u.uCell, ...res.cell);
        gl.uniform2f(u.uAtlas, ...res.size);
        gl.uniform4f(u.uBox, PAD * f.dpr, PAD * f.dpr, (W + PAD) * f.dpr, (H + PAD) * f.dpr);
        gl.uniform1f(u.uDpr, f.dpr);
        gl.uniform1f(u.uBar, 2 * f.dpr);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, clusters.length);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
      },
    };
  };
})();
