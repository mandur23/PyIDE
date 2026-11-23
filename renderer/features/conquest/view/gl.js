// The map's WebGL2 pass: one full-canvas triangle whose fragment shader reads the province id of its texture pixel from
// an integer texture, the province's fill colour and owner from two lookup textures indexed by id, and draws borders
// where a pixel one or two device pixels away has another id (province), another owner (thicker, darker) or is sea on
// one side only (coast). Selected and hovered provinces are lightened, the selected one outlined. A sea zone is drawn
// in the sea colour mixed toward its fill colour by the fill's alpha (sea control); a land fill's alpha is ignored.
// Conquest.view.renderer(canvas, data) with data = { width, height, ids, count, fill, meta } (fill and meta: Uint8Array
// of (count + 1) * 4, RGBA per id; meta is owner + 1 as two bytes and flags) and options { layers, onRestored }
// -> { draw(frame), update(which, ids), info, dispose }. A layer ({ build(gl, compile), draw(gl, frame) }) draws over
// the map in the same context. The caller keeps data; a lost context is rebuilt from it when the browser restores it.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const LW = 2048;
  const FULL_UPLOAD_AT = 256;

  const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uIds;
uniform sampler2D uFill;
uniform sampler2D uMeta;
uniform vec2 uOrigin;
uniform float uTexPerPx;
uniform float uViewH;
uniform ivec2 uSize;
uniform uint uSel;
uniform uint uHover;
uniform float uProvAlpha;
uniform vec3 uSea, uCoast, uOutside, uProvLine, uOwnerLine, uSelLine;
out vec4 outColor;
const int LW = ${LW};
uint idAt(vec2 t) {
  ivec2 p = ivec2(floor(t));
  if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) return 0u;
  return texelFetch(uIds, p, 0).r;
}
ivec2 lut(uint id) { int i = int(id); return ivec2(i % LW, i / LW); }
vec4 metaOf(uint id) { return texelFetch(uMeta, lut(id), 0); }
bool seaOf(vec4 m, uint id) { return id == 0u || m.b > 0.002; }
void main() {
  vec2 t = uOrigin + vec2(gl_FragCoord.x, uViewH - gl_FragCoord.y) * uTexPerPx;
  if (t.x < 0.0 || t.y < 0.0 || t.x >= float(uSize.x) || t.y >= float(uSize.y)) { outColor = vec4(uOutside, 1.0); return; }
  uint id = idAt(t);
  vec4 m = metaOf(id);
  bool sea = seaOf(m, id);
  vec4 f = texelFetch(uFill, lut(id), 0);
  vec3 c = sea ? mix(uSea, f.rgb, f.a) : f.rgb;
  float d = uTexPerPx;
  uint n0 = idAt(t + vec2(d, 0.0));
  uint n1 = idAt(t + vec2(0.0, d));
  uint n2 = idAt(t - vec2(d, 0.0));
  uint n3 = idAt(t - vec2(0.0, d));
  if (id == uHover && !sea) c = mix(c, vec3(1.0), 0.18);
  if (id == uSel) c = mix(c, vec3(1.0), sea ? 0.15 : 0.32);
  if (!sea && (n0 != id || n1 != id)) c = mix(c, uProvLine, uProvAlpha);
  vec4 m0 = metaOf(n0), m1 = metaOf(n1), m2 = metaOf(n2), m3 = metaOf(n3);
  bool coast = !sea && (seaOf(m0, n0) || seaOf(m1, n1) || seaOf(m2, n2) || seaOf(m3, n3));
  vec2 own = m.rg;
  bool front = !sea && ((!seaOf(m0, n0) && m0.rg != own) || (!seaOf(m1, n1) && m1.rg != own)
    || (!seaOf(m2, n2) && m2.rg != own) || (!seaOf(m3, n3) && m3.rg != own));
  if (front) c = uOwnerLine;
  if (coast) c = uCoast;
  bool inSel = id == uSel;
  if (uSel != 0u && (inSel != (n0 == uSel) || inSel != (n1 == uSel) || inSel != (n2 == uSel) || inSel != (n3 == uSel))) c = uSelLine;
  outColor = vec4(c, 1.0);
}`;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  view.renderer = (canvas, data, { layers = [], onRestored } = {}) => {
    let gl = null;
    let res = null;
    let lost = false;
    const rows = Math.ceil((data.count + 1) / LW);
    const lutBytes = (src) => {
      const out = new Uint8Array(LW * rows * 4);
      out.set(src.subarray(0, Math.min(src.length, out.length)));
      return out;
    };

    function shader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    }
    function texture(unit) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    }

    function build() {
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available');
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (data.width > max || data.height > max) throw new Error(`the map is ${data.width}x${data.height} but this GPU takes at most ${max}`);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      const prog = compile(VERT, FRAG);
      gl.useProgram(prog);
      const u = Object.fromEntries(['uIds', 'uFill', 'uMeta', 'uOrigin', 'uTexPerPx', 'uViewH', 'uSize', 'uSel', 'uHover', 'uProvAlpha',
        'uSea', 'uCoast', 'uOutside', 'uProvLine', 'uOwnerLine', 'uSelLine'].map((n) => [n, gl.getUniformLocation(prog, n)]));
      const ids = texture(0);
      const wide = data.ids instanceof Uint32Array;
      gl.texImage2D(gl.TEXTURE_2D, 0, wide ? gl.R32UI : gl.R16UI, data.width, data.height, 0, gl.RED_INTEGER, wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, data.ids);
      const fill = texture(1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LW, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes(data.fill));
      const meta = texture(2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LW, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes(data.meta));
      gl.uniform1i(u.uIds, 0);
      gl.uniform1i(u.uFill, 1);
      gl.uniform1i(u.uMeta, 2);
      gl.uniform2i(u.uSize, data.width, data.height);
      const vao = gl.createVertexArray();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      res = { prog, vao, u, tex: { fill, meta }, info: {
        maxTexture: max,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      } };
      for (const layer of layers) layer.build(gl, compile);
    }
    function compile(vert, frag) {
      const prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, vert));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
      return prog;
    }

    const onLost = (e) => { e.preventDefault(); lost = true; };
    const onRestore = () => { lost = false; build(); onRestored?.(); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestore);
    build();

    return {
      get info() { return res.info; },
      get lost() { return lost; },
      get gl() { return gl; },
      // which: 'fill' | 'meta'; ids: the ids whose entries changed, or null for all of them.
      update(which, ids) {
        if (lost) return;
        const src = data[which];
        gl.activeTexture(which === 'fill' ? gl.TEXTURE1 : gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, res.tex[which]);
        if (!ids || ids.length > FULL_UPLOAD_AT) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LW, rows, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes(src));
          return;
        }
        for (const id of ids) gl.texSubImage2D(gl.TEXTURE_2D, 0, id % LW, Math.floor(id / LW), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, src, id * 4);
      },
      // frame: { x, y, texPerPx, width, height (device pixels), dpr, selected, hovered, provAlpha, palette }
      draw(f) {
        if (lost) return false;
        const { u } = res;
        if (canvas.width !== f.width || canvas.height !== f.height) { canvas.width = f.width; canvas.height = f.height; }
        gl.viewport(0, 0, f.width, f.height);
        gl.useProgram(res.prog);
        gl.bindVertexArray(res.vao);
        gl.uniform2f(u.uOrigin, f.x, f.y);
        gl.uniform1f(u.uTexPerPx, f.texPerPx);
        gl.uniform1f(u.uViewH, f.height);
        gl.uniform1ui(u.uSel, f.selected >>> 0);
        gl.uniform1ui(u.uHover, f.hovered >>> 0);
        gl.uniform1f(u.uProvAlpha, f.provAlpha);
        for (const k of ['Sea', 'Coast', 'Outside', 'ProvLine', 'OwnerLine', 'SelLine']) gl.uniform3fv(u[`u${k}`], rgb(f.palette[k]));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        for (const layer of layers) layer.draw(gl, f);
        return true;
      },
      dispose() {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestore);
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  };
})();
