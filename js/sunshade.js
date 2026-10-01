'use strict';
/* Terrain sun-shadow drawn in the browser, draped over MapLibre's 3D terrain. A terrain-only port of Sundrift's geographic mode
   (sundrift/engine/public/assets/sunshadow.js, reused with the owner's permission): for every texel of a map-aligned patch, march
   from its elevation toward the sun across a stitched Terrarium DEM texture; in shadow when the terrain rises above the sun line.
   Glett's changes: the patch follows the map view (rebuilt when the view leaves it), the march reaches ~10 km, the whole patch is
   dark when the sun is down, and rectangles covered by Sundrift's accurate server data are cut out so those tiles show instead. */
window.GlettShade = (function () {
  const VERT = 'attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }';
  const FRAG = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_dem;
uniform float u_sunAzimuth, u_sunAltitude, u_metersPerTexel, u_opacity, u_stepTexels;
uniform vec2 u_texSize;
float elev(vec2 uv) { vec4 c = texture2D(u_dem, uv); return c.r * 65536.0 + c.g * 256.0 + c.b - 32768.0; }
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  float base = elev(uv);
  vec2 dir = vec2(sin(u_sunAzimuth), -cos(u_sunAzimuth));
  float tanAlt = tan(u_sunAltitude), shadow = 0.0, step = u_stepTexels / u_texSize.x;
  for (int i = 1; i <= 256; i++) {
    vec2 s = uv + dir * step * float(i);
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) break;
    if (elev(s) > base + float(i) * u_stepTexels * u_metersPerTexel * tanAlt) { shadow = 1.0; break; }
  }
  float a = shadow * u_opacity;
  gl_FragColor = vec4(vec3(0.0588, 0.0902, 0.1647) * a, a);   // rgb(15,23,42) like the accurate tiles, premultiplied
}`;
  const BLUR = `precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_dir;
void main() { vec4 c = texture2D(u_tex, v_uv) * 0.38774; c += (texture2D(u_tex, v_uv + u_dir) + texture2D(u_tex, v_uv - u_dir)) * 0.24477;
  c += (texture2D(u_tex, v_uv + u_dir * 2.0) + texture2D(u_tex, v_uv - u_dir * 2.0)) * 0.06136; gl_FragColor = c; }`;

  const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
  const lat2tile = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
  const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
  const tile2lat = (y, z) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));
  const mercX = (lon) => (lon + 180) / 360, mercY = (lat) => lat2tile(lat, 0);   // 0..1, y = 0 at the north
  const mPerPx = (lat, z) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);
  const sunFade = (alt) => { const t = Math.max(0, Math.min(1, alt / 0.122)); return t * t * (3 - 2 * t); };   // soft near the horizon

  function compile(gl, vs, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
  }

  function create(map, opts) {
    const tileBase = opts.tileBase, opacity = opts.opacity ?? 0.47, SRC = 'glett-sunshade', LYR = 'glett-sunshade';
    const small = window.matchMedia('(max-width: 700px)').matches, MAX_TILES = small ? 6 : 8, CANVAS = small ? 1000 : 2000;   // not a power of two: MapLibre would mipmap it and the draped layer came out black
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = CANVAS;
    // what MapLibre drapes: a 2D copy of the WebGL result (a WebGL canvas handed to MapLibre directly arrives without its alpha)
    let out = null;   // the 2D copy MapLibre shows (a WebGL canvas handed to it directly arrives without its alpha); kept, redrawn per render
    // preserveDrawingBuffer: MapLibre uploads this canvas on its own schedule, so the buffer must survive compositing
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const prog = compile(gl, VERT, FRAG), blur = compile(gl, VERT, BLUR);
    if (!prog || !blur) return null;
    const U = {}; ['u_dem', 'u_sunAzimuth', 'u_sunAltitude', 'u_metersPerTexel', 'u_opacity', 'u_stepTexels', 'u_texSize'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const mkTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v)); return t; };
    const demTex = mkTex(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 0, 0, 255]));
    const texA = mkTex(), texB = mkTex();
    [texA, texB].forEach((t) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CANVAS, CANVAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); });
    const fbo = (t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };
    const fboA = fbo(texA), fboB = fbo(texB); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const quad = (p) => { const loc = gl.getAttribLocation(p, 'a_pos'); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(loc); };

    let patch = null, ready = false, sun = null, mask = [], removed = false, loadTok = 0;

    /* The DEM patch: the view padded on every side, at the finest zoom that stays within MAX_TILES x MAX_TILES tiles */
    function wantPatch() {
      const b = map.getBounds(), c = map.getCenter();
      const w = b.getWest(), e = b.getEast(), n = Math.min(85, b.getNorth()), s = Math.max(-85, b.getSouth()), padX = (e - w) * 0.5, padY = (n - s) * 0.5;
      for (let z = 12; z >= 5; z--) {
        const x0 = Math.floor(lon2tile(w - padX, z)), x1 = Math.floor(lon2tile(e + padX, z)), y0 = Math.floor(lat2tile(Math.min(85, n + padY), z)), y1 = Math.floor(lat2tile(Math.max(-85, s - padY), z));
        if (x1 - x0 + 1 <= MAX_TILES && y1 - y0 + 1 <= MAX_TILES) return { z, x0, x1, y0, y1, lat: c.lat };
      }
      return null;
    }
    function covers(p) {   // the current patch still serves the view: it contains it, at the same detail
      if (!patch || !p || p.z !== patch.z) return false;
      return p.x0 >= patch.x0 && p.x1 <= patch.x1 && p.y0 >= patch.y0 && p.y1 <= patch.y1;
    }
    function update() {
      if (removed) return;
      const p = wantPatch(); if (!p || covers(p)) return;
      const tok = ++loadTok, cols = p.x1 - p.x0 + 1, rows = p.y1 - p.y0 + 1, off = document.createElement('canvas');
      off.width = cols * 256; off.height = rows * 256;
      const ctx = off.getContext('2d'); let left = cols * rows;
      const done = () => {
        if (tok !== loadTok || removed) return;
        gl.bindTexture(gl.TEXTURE_2D, demTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
        p.west = tile2lon(p.x0, p.z); p.east = tile2lon(p.x1 + 1, p.z); p.north = tile2lat(p.y0, p.z); p.south = tile2lat(p.y1 + 1, p.z);
        p.mx0 = mercX(p.west); p.mx1 = mercX(p.east); p.my0 = mercY(p.north); p.my1 = mercY(p.south);
        p.mpt = mPerPx(p.lat, p.z) * (off.width / CANVAS);   // metres per canvas texel
        patch = p; ready = true; render();
      };
      for (let ty = p.y0; ty <= p.y1; ty++) for (let tx = p.x0; tx <= p.x1; tx++) {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, (tx - p.x0) * 256, (ty - p.y0) * 256); if (--left === 0) done(); };
        img.onerror = () => { if (--left === 0) done(); };   // a missing tile stays blank: 0 m there (the sea), no false shadow
        img.src = `${tileBase}/${p.z}/${tx}/${ty}.png`;
      }
    }
    function place() {   // a live canvas source on the map (see smImageLayer)
      const coords = [[patch.west, patch.north], [patch.east, patch.north], [patch.east, patch.south], [patch.west, patch.south]];
      const firstShade = map.getStyle().layers.find((l) => l.id.startsWith('shade-'));   // below Sundrift's accurate tiles
      opts.imageLayer(map, LYR, out, coords, firstShade ? firstShade.id : undefined);
    }
    function render() {
      if (!ready || !sun || removed) return;
      const [az, alt] = sun;
      gl.viewport(0, 0, CANVAS, CANVAS); gl.clearColor(0, 0, 0, 0);
      if (alt > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, demTex); gl.uniform1i(U.u_dem, 0);
        const stepTexels = Math.max(1, Math.min(4, 10000 / 256 / patch.mpt));   // aim for ~10 km of reach in 256 steps
        gl.uniform1f(U.u_sunAzimuth, az); gl.uniform1f(U.u_sunAltitude, alt); gl.uniform1f(U.u_metersPerTexel, patch.mpt); gl.uniform1f(U.u_stepTexels, stepTexels);
        gl.uniform2f(U.u_texSize, CANVAS, CANVAS); gl.uniform1f(U.u_opacity, opacity * Math.max(sunFade(alt), 0));
        quad(prog);
        const bl = (from, to, dx, dy) => { gl.bindFramebuffer(gl.FRAMEBUFFER, to); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(blur); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from); gl.uniform1i(gl.getUniformLocation(blur, 'u_tex'), 0); gl.uniform2f(gl.getUniformLocation(blur, 'u_dir'), dx, dy); quad(blur); };
        bl(texA, fboB, 0.8 / CANVAS, 0); bl(texB, null, 0, 0.8 / CANVAS);
      } else {   // the sun is down: the whole patch is dark, as in Sundrift's data
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0.0588 * opacity, 0.0902 * opacity, 0.1647 * opacity, opacity); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearColor(0, 0, 0, 0);
      }
      // cut out the rectangles where Sundrift's accurate data is on the map, so it is not darkened twice
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.enable(gl.SCISSOR_TEST);
      mask.forEach(([mx0, my0, mx1, my1]) => {
        const x0 = Math.round(((mx0 - patch.mx0) / (patch.mx1 - patch.mx0)) * CANVAS), x1 = Math.round(((mx1 - patch.mx0) / (patch.mx1 - patch.mx0)) * CANVAS);   // nearest pixel: at most half a pixel off the tile's edge
        const yTop = Math.round(((my0 - patch.my0) / (patch.my1 - patch.my0)) * CANVAS), yBot = Math.round(((my1 - patch.my0) / (patch.my1 - patch.my0)) * CANVAS);
        const sx = Math.max(0, x0), sw = Math.min(CANVAS, x1) - sx, sy = Math.max(0, CANVAS - yBot), sh = Math.min(CANVAS, CANVAS - yTop) - sy;
        if (sw > 0 && sh > 0) { gl.scissor(sx, sy, sw, sh); gl.clear(gl.COLOR_BUFFER_BIT); }
      });
      gl.disable(gl.SCISSOR_TEST);
      if (!out) { out = document.createElement('canvas'); out.width = out.height = CANVAS; }
      const octx = out.getContext('2d'); octx.clearRect(0, 0, CANVAS, CANVAS); octx.drawImage(canvas, 0, 0);
      place();
    }
    return {
      update,
      setSun(az, alt) { sun = [az, alt]; render(); },
      setMask(rects) { mask = rects || []; render(); },
      remove() {
        removed = true;
        try { if (map.getLayer(LYR)) map.removeLayer(LYR); if (map.getSource(SRC)) map.removeSource(SRC); } catch (e) { /* map gone */ }
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      },
      get patch() { return patch; },
      get canvas() { return canvas; },
    };
  }
  return { create };
})();
