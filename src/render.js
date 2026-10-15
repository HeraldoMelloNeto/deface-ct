// Renderização de superfície (isossuperfície de pele) por lançamento de raios em projeção ortográfica.
// Usada na interface (com resolução reduzida durante a rotação) e nos testes.

/** prev: {nx, ny, nz, sx, sy, sz, data:Uint8Array}; opts: {w, h, yaw, pitch, thr, bg:[r,g,b], tint:[r,g,b]} */
export function renderSurface(prev, opts) {
  const { nx, ny, nz, sx, sy, sz, data } = prev;
  const W = opts.w | 0, H = opts.h | 0;
  const out = opts.out && opts.out.length === W * H * 4 ? opts.out : new Uint8ClampedArray(W * H * 4);
  const thr = opts.thr ?? (-300 + 1024) / 8;
  const yaw = (opts.yaw || 0) * Math.PI / 180, pitch = (opts.pitch || 0) * Math.PI / 180;
  const bg = opts.bg || [0, 0, 0], tint = opts.tint || [222, 200, 182];
  const bgA = opts.bgAlpha ?? 255;
  // direção de visada: de anterior (y=0) para posterior, girada em torno de z (yaw) e inclinada (pitch)
  const cp = Math.cos(pitch), spn = Math.sin(pitch);
  const d = [Math.sin(yaw) * cp, Math.cos(yaw) * cp, -spn];
  const r = [Math.cos(yaw), -Math.sin(yaw), 0];
  const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]]; // cima = d × r
  // garante que "cima" aponte para +z
  if (u[2] < 0) { u[0] = -u[0]; u[1] = -u[1]; u[2] = -u[2]; }
  const ex = nx * sx, ey = ny * sy, ez = nz * sz;
  const ext = Math.max(ex, ey, ez) * (opts.zoom ? 1 / opts.zoom : 1.04);
  const cx = ex / 2, cy = ey / 2, cz = ez / 2;
  const R = Math.sqrt(ex * ex + ey * ey + ez * ez) / 2 + 1;
  const vmin = Math.min(sx, sy, sz);
  const step = vmin * 0.9;
  const nxy = nx * ny;
  const L = norm([-0.35, -0.75, 0.55]); // luz vinda de frente, do alto e da esquerda do observador
  const Lw = [L[0] * r[0] + L[1] * d[0] + L[2] * u[0], L[0] * r[1] + L[1] * d[1] + L[2] * u[1], L[0] * r[2] + L[1] * d[2] + L[2] * u[2]];
  const H2 = norm([Lw[0] - d[0], Lw[1] - d[1], Lw[2] - d[2]]);
  const isx = 1 / sx, isy = 1 / sy, isz = 1 / sz;

  const tri = (px, py, pz) => {
    let fx = px * isx - 0.5, fy = py * isy - 0.5, fz = pz * isz - 0.5;
    if (fx < 0) fx = 0; else if (fx > nx - 1.001) fx = nx - 1.001;
    if (fy < 0) fy = 0; else if (fy > ny - 1.001) fy = ny - 1.001;
    if (fz < 0) fz = 0; else if (fz > nz - 1.001) fz = nz - 1.001;
    const x0 = fx | 0, y0 = fy | 0, z0 = fz | 0;
    const ax = fx - x0, ay = fy - y0, az = fz - z0;
    const i = (z0 * ny + y0) * nx + x0;
    const c00 = data[i] + (data[i + 1] - data[i]) * ax;
    const c10 = data[i + nx] + (data[i + nx + 1] - data[i + nx]) * ax;
    const c01 = data[i + nxy] + (data[i + nxy + 1] - data[i + nxy]) * ax;
    const c11 = data[i + nxy + nx] + (data[i + nxy + nx + 1] - data[i + nxy + nx]) * ax;
    const c0 = c00 + (c10 - c00) * ay, c1 = c01 + (c11 - c01) * ay;
    return c0 + (c1 - c0) * az;
  };

  for (let j = 0; j < H; j++) {
    const sv = (0.5 - (j + 0.5) / H) * ext;
    for (let i = 0; i < W; i++) {
      const su = ((i + 0.5) / W - 0.5) * ext;
      const ox = cx + su * r[0] + sv * u[0] - R * d[0];
      const oy = cy + su * r[1] + sv * u[1] - R * d[1];
      const oz = cz + su * r[2] + sv * u[2] - R * d[2];
      // interseção com a caixa do volume
      let t0 = 0, t1 = 2 * R;
      const o = [ox, oy, oz], mx = [ex, ey, ez];
      let miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-9) { if (o[a] < 0 || o[a] > mx[a]) { miss = true; break; } continue; }
        let ta = (0 - o[a]) / d[a], tb = (mx[a] - o[a]) / d[a];
        if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      }
      const p = (j * W + i) * 4;
      if (miss || t0 >= t1) { out[p] = bg[0]; out[p + 1] = bg[1]; out[p + 2] = bg[2]; out[p + 3] = bgA; continue; }
      let hitT = -1, prevT = t0;
      for (let t = t0; t <= t1; t += step) {
        const px = ox + t * d[0], py = oy + t * d[1], pz = oz + t * d[2];
        // amostra mais próxima (rápida) para busca grosseira
        let ix = (px * isx) | 0, iy = (py * isy) | 0, iz = (pz * isz) | 0;
        if (ix >= nx) ix = nx - 1; if (iy >= ny) iy = ny - 1; if (iz >= nz) iz = nz - 1;
        if (ix < 0) ix = 0; if (iy < 0) iy = 0; if (iz < 0) iz = 0;
        if (data[(iz * ny + iy) * nx + ix] >= thr - 6) {
          if (tri(px, py, pz) >= thr) { hitT = t; break; }
        }
        prevT = t;
      }
      if (hitT < 0) { out[p] = bg[0]; out[p + 1] = bg[1]; out[p + 2] = bg[2]; out[p + 3] = bgA; continue; }
      let a = prevT, b = hitT;
      for (let k = 0; k < 6; k++) {
        const m = (a + b) / 2;
        if (tri(ox + m * d[0], oy + m * d[1], oz + m * d[2]) >= thr) b = m; else a = m;
      }
      const px = ox + b * d[0], py = oy + b * d[1], pz = oz + b * d[2];
      let gx = tri(px + sx, py, pz) - tri(px - sx, py, pz);
      let gy = tri(px, py + sy, pz) - tri(px, py - sy, pz);
      let gz = tri(px, py, pz + sz) - tri(px, py, pz - sz);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx = -gx / gl; gy = -gy / gl; gz = -gz / gl; // normal para fora
      let diff = gx * Lw[0] + gy * Lw[1] + gz * Lw[2]; if (diff < 0) diff = 0;
      let spec = gx * H2[0] + gy * H2[1] + gz * H2[2]; spec = spec > 0 ? Math.pow(spec, 28) * 0.22 : 0;
      const amb = 0.24;
      const k = amb + 0.76 * diff;
      out[p] = Math.min(255, tint[0] * k + 255 * spec);
      out[p + 1] = Math.min(255, tint[1] * k + 255 * spec);
      out[p + 2] = Math.min(255, tint[2] * k + 255 * spec);
      out[p + 3] = 255;
    }
  }
  return out;
}

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function erode6(m, nx, ny, nz) {
  const o = new Uint8Array(m.length), nxy = nx * ny;
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = (z * ny + y) * nx + x;
    if (m[i] && m[i - 1] && m[i + 1] && m[i - nx] && m[i + nx] && m[i - nxy] && m[i + nxy]) o[i] = 1;
  }
  return o;
}
function dilate6(m, nx, ny, nz) {
  const o = m.slice(), nxy = nx * ny;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = (z * ny + y) * nx + x;
    if (!m[i]) continue;
    if (x > 0) o[i - 1] = 1; if (x < nx - 1) o[i + 1] = 1;
    if (y > 0) o[i - nx] = 1; if (y < ny - 1) o[i + nx] = 1;
    if (z > 0) o[i - nxy] = 1; if (z < nz - 1) o[i + nxy] = 1;
  }
  return o;
}

/** Mantém apenas a cabeça: abertura morfológica (rompe contatos finos com mesa/suporte),
 *  maior componente 3D e reconstrução dentro da máscara original. */
export function keepLargestComponent(prev, thr = (-500 + 1024) / 8) {
  const { nx, ny, nz, data } = prev;
  const n = nx * ny * nz;
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = data[i] >= thr ? 1 : 0;
  const R = 2;
  let e = m;
  for (let k = 0; k < R; k++) e = erode6(e, nx, ny, nz);
  const core = largestLabel(e, nx, ny, nz);
  // reconstrução geodésica limitada (recupera nariz, orelhas e pele; só um pequeno trecho do suporte)
  let keep = core;
  for (let k = 0; k < 14; k++) { keep = dilate6(keep, nx, ny, nz); for (let i = 0; i < n; i++) keep[i] &= m[i]; }
  for (let i = 0; i < n; i++) if (m[i] && !keep[i]) data[i] = 0;
  return prev;
}

function largestLabel(m, nx, ny, nz) {
  const n = m.length, lab = new Int32Array(n), stack = new Int32Array(n), nxy = nx * ny;
  let best = 0, bestSize = 0, cur = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] || !m[s]) continue;
    cur++; let sp = 0, size = 0; stack[sp++] = s; lab[s] = cur;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / nxy) | 0;
      let j;
      if (x > 0) { j = i - 1; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
      if (x < nx - 1) { j = i + 1; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
      if (y > 0) { j = i - nx; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
      if (y < ny - 1) { j = i + nx; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
      if (z > 0) { j = i - nxy; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
      if (z < nz - 1) { j = i + nxy; if (!lab[j] && m[j]) { lab[j] = cur; stack[sp++] = j; } }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lab[i] === best && best) out[i] = 1;
  return out;
}

/** (versão antiga, sem abertura) */
export function keepLargestComponentSimple(prev, thr = (-500 + 1024) / 8) {
  const { nx, ny, nz, data } = prev;
  const n = nx * ny * nz;
  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  let best = 0, bestSize = 0, cur = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] || data[s] < thr) continue;
    cur++;
    let sp = 0, size = 0;
    stack[sp++] = s; lab[s] = cur;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
      let j;
      if (x > 0) { j = i - 1; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
      if (x < nx - 1) { j = i + 1; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
      if (y > 0) { j = i - nx; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
      if (y < ny - 1) { j = i + nx; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
      if (z > 0) { j = i - nx * ny; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
      if (z < nz - 1) { j = i + nx * ny; if (!lab[j] && data[j] >= thr) { lab[j] = cur; stack[sp++] = j; } }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  for (let i = 0; i < n; i++) if (data[i] >= thr && lab[i] !== best) data[i] = 0;
  return prev;
}
