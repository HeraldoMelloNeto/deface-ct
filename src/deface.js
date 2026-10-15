// Deface CT — detecção de olhos, nariz, boca e mento e substituição da superfície facial
// por uma face genérica, com mistura aleatória de ±2 voxels em torno da pele.
//
// Volume canônico: Int16Array em UH, índice (z*ny + y)*nx + x
//   x: direita -> esquerda do paciente; y: anterior -> posterior; z: inferior -> superior.

const AIR_T = -500;   // limiar pele/ar (UH)
const BONE_T = 250;   // osso/dentes (UH)

// ---------- utilidades 2D ----------
function gauss1d(sigmaPx) {
  const r = Math.max(1, Math.ceil(sigmaPx * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigmaPx) ** 2); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

/** Desfoque gaussiano separável que ignora NaN (normalizado pelos pesos válidos). */
export function blur2D(a, h, w, sy, sx) {
  const tmpV = new Float32Array(h * w), tmpW = new Float32Array(h * w);
  const g1 = gauss1d(Math.max(0.5, sx)), g2 = gauss1d(Math.max(0.5, sy));
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      let sv = 0, sw = 0;
      for (let t = -g1.r; t <= g1.r; t++) {
        const jj = j + t; if (jj < 0 || jj >= w) continue;
        const v = a[i * w + jj]; if (v !== v) continue;
        const kk = g1.k[t + g1.r]; sv += v * kk; sw += kk;
      }
      tmpV[i * w + j] = sv; tmpW[i * w + j] = sw;
    }
  }
  const out = new Float32Array(h * w);
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      let sv = 0, sw = 0;
      for (let t = -g2.r; t <= g2.r; t++) {
        const ii = i + t; if (ii < 0 || ii >= h) continue;
        const kk = g2.k[t + g2.r];
        sv += tmpV[ii * w + j] * kk; sw += tmpW[ii * w + j] * kk;
      }
      out[i * w + j] = sw > 1e-6 ? sv / sw : NaN;
    }
  }
  return out;
}

function maxFilter2D(a, h, w, ry, rx) {
  const t = new Float32Array(h * w), out = new Float32Array(h * w);
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let m = 0;
    for (let d = -rx; d <= rx; d++) { const jj = j + d; if (jj >= 0 && jj < w) { const v = a[i * w + jj]; if (v > m) m = v; } }
    t[i * w + j] = m;
  }
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let m = 0;
    for (let d = -ry; d <= ry; d++) { const ii = i + d; if (ii >= 0 && ii < h) { const v = t[ii * w + j]; if (v > m) m = v; } }
    out[i * w + j] = m;
  }
  return out;
}

// Transformada de distância euclidiana exata (Felzenszwalb & Huttenlocher) em 1D, com espaçamento (mm)
function edt1d(f, n, sp, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const pq = q * sp;
    let s;
    for (;;) {
      const r = v[k], pr = r * sp;
      s = ((f[q] + pq * pq) - (f[r] + pr * pr)) / (2 * (pq - pr));
      if (s <= z[k]) { k--; continue; }
      break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    const pq = q * sp;
    while (z[k + 1] < pq) k++;
    const pr = v[k] * sp;
    d[q] = (pq - pr) * (pq - pr) + f[v[k]];
  }
}

/** EDT 3D (distância ao fundo, em mm) de uma máscara binária pequena. */
export function edt3d(mask, nx, ny, nz, sx, sy, sz) {
  const INF = 1e10;
  const n = nx * ny * nz;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = mask[i] ? INF : 0;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), zz = new Float64Array(m + 1);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const o = (z * ny + y) * nx;
    for (let x = 0; x < nx; x++) f[x] = g[o + x];
    edt1d(f, nx, sx, d, v, zz);
    for (let x = 0; x < nx; x++) g[o + x] = d[x];
  }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = g[(z * ny + y) * nx + x];
    edt1d(f, ny, sy, d, v, zz);
    for (let y = 0; y < ny; y++) g[(z * ny + y) * nx + x] = d[y];
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) f[z] = g[(z * ny + y) * nx + x];
    edt1d(f, nz, sz, d, v, zz);
    for (let z = 0; z < nz; z++) g[(z * ny + y) * nx + x] = d[z];
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function boxBlur3(a, nx, ny, nz) {
  const t1 = new Float32Array(a.length), t2 = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    const o = (z * ny + y) * nx;
    for (let x = 0; x < nx; x++) { let s = 0, c = 0; for (let d = -1; d <= 1; d++) { const xx = x + d; if (xx >= 0 && xx < nx) { s += a[o + xx]; c++; } } t1[o + x] = s / c; }
  }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
    let s = 0, c = 0; for (let d = -1; d <= 1; d++) { const yy = y + d; if (yy >= 0 && yy < ny) { s += t1[(z * ny + yy) * nx + x]; c++; } }
    t2[(z * ny + y) * nx + x] = s / c;
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
    let s = 0, c = 0; for (let d = -1; d <= 1; d++) { const zz = z + d; if (zz >= 0 && zz < nz) { s += t2[(zz * ny + y) * nx + x]; c++; } }
    out[(z * ny + y) * nx + x] = s / c;
  }
  return out;
}

// Gerador pseudoaleatório rápido (xorshift) com semente aleatória por exame
function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------- 1. Pele e máscara da cabeça por corte ----------
function labelLargest(mask, w, h, lab, parent) {
  // rotulagem 4-conectada em duas passagens com union-find; retorna rótulo do maior componente
  let next = 1;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < w * h; i++) lab[i] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    const up = y > 0 ? lab[i - w] : 0, lf = x > 0 ? lab[i - 1] : 0;
    if (!up && !lf) { if (next >= parent.length) return -1; parent[next] = next; lab[i] = next++; }
    else if (up && lf) { const a = find(up), b = find(lf); lab[i] = a < b ? a : b; if (a !== b) parent[a > b ? a : b] = a < b ? a : b; }
    else lab[i] = up || lf;
  }
  const area = new Int32Array(next);
  for (let i = 0; i < w * h; i++) if (lab[i]) { lab[i] = find(lab[i]); area[lab[i]]++; }
  let best = 0, ba = 0;
  for (let k = 1; k < next; k++) if (area[k] > ba) { ba = area[k]; best = k; }
  return best;
}

export function analyzeSkin(V) {
  const { vol, nx, ny, nz, sy } = V;
  const d0 = new Float32Array(nz * nx).fill(NaN);
  const yHit = new Int32Array(nz * nx).fill(-1);
  const bbox = [];
  const mask = new Uint8Array(nx * ny), lab = new Int32Array(nx * ny), parent = new Int32Array(nx * ny + 1);
  for (let z = 0; z < nz; z++) {
    const o = z * ny * nx;
    let any = false;
    for (let i = 0; i < nx * ny; i++) { const m = vol[o + i] > AIR_T ? 1 : 0; mask[i] = m; if (m) any = true; }
    if (!any) { bbox.push(null); continue; }
    const L = labelLargest(mask, nx, ny, lab, parent);
    if (L <= 0) { bbox.push(null); continue; }
    let x0 = nx, x1 = -1, y0 = ny, y1 = -1, area = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (lab[y * nx + x] === L) {
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    bbox.push({ x0, x1, y0, y1, area });
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        if (lab[y * nx + x] === L) {
          yHit[z * nx + x] = y;
          let pos = y;
          if (y > 0) {
            const a = vol[o + (y - 1) * nx + x], b = vol[o + y * nx + x];
            if (b !== a) pos = y - 1 + clamp((AIR_T - a) / (b - a), 0, 1);
          }
          d0[z * nx + x] = pos * sy;
          break;
        }
      }
    }
  }
  return { d0, yHit, bbox };
}

// ---------- 2. Pontos de referência ----------
function findBoneDepth(V, S) {
  const { vol, nx, ny, nz, sy } = V;
  const bone = new Float32Array(nz * nx).fill(Infinity);
  const maxSteps = Math.ceil(70 / sy);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const y0 = S.yHit[z * nx + x];
    if (y0 < 0) continue;
    const o = z * ny * nx + x;
    for (let y = y0, k = 0; y < ny && k < maxSteps; y++, k++) {
      if (vol[o + y * nx] > BONE_T) { bone[z * nx + x] = y * sy; break; }
    }
  }
  return bone;
}

function detectLandmarks(V, S, bone, notes) {
  const { vol, nx, ny, nz, sx, sy, sz } = V;
  const { d0, bbox } = S;
  // linha média: mediana dos centros das caixas da cabeça na metade superior com cabeça
  const centers = [], widths = new Float32Array(nz).fill(NaN);
  for (let z = 0; z < nz; z++) {
    const b = bbox[z]; if (!b) continue;
    widths[z] = (b.x1 - b.x0 + 1) * sx;
    if (b.area * sx * sy > 8000) centers.push((b.x0 + b.x1) / 2);
  }
  if (!centers.length) throw new Error('nohead');
  centers.sort((a, b) => a - b);
  const mx = centers[centers.length >> 1];

  // superfície suavizada e protrusão
  const sm = blur2D(d0, nz, nx, 20 / sz, 20 / sx);
  let best = -Infinity, nzI = -1, nxI = -1;
  const band = Math.round(15 / sx);
  for (let z = 0; z < nz; z++) for (let x = Math.max(0, Math.round(mx - band)); x <= Math.min(nx - 1, Math.round(mx + band)); x++) {
    const k = z * nx + x;
    const v = d0[k]; if (v !== v) continue;
    const p = sm[k] - v;
    if (p > best) { best = p; nzI = z; nxI = x; }
  }
  if (nzI < 0 || best < 5) throw new Error('nonose');
  const nose = { z: nzI, x: nxI, d: d0[nzI * nx + nxI], prot: best };

  // olhos: maior esfera de partes moles anterior ao 1º osso, em cada órbita
  const eyes = [];
  for (const side of [-1, 1]) {
    const zA = Math.max(0, Math.round(nose.z + 12 / sz)), zB = Math.min(nz - 1, Math.round(nose.z + 75 / sz));
    const xA = Math.round(mx + side * 8 / sx), xB = Math.round(mx + side * 58 / sx);
    const xa = clamp(Math.min(xA, xB), 0, nx - 1), xb = clamp(Math.max(xA, xB), 0, nx - 1);
    if (zB <= zA || xb <= xa) { eyes.push(null); continue; }
    let yMin = ny, yMax = 0;
    for (let z = zA; z <= zB; z++) for (let x = xa; x <= xb; x++) {
      const y0 = S.yHit[z * nx + x]; if (y0 < 0) continue;
      if (y0 < yMin) yMin = y0;
      const ye = Math.min(ny - 1, y0 + Math.round(45 / sy));
      if (ye > yMax) yMax = ye;
    }
    if (yMax <= yMin) { eyes.push(null); continue; }
    const bx = xb - xa + 1, by = yMax - yMin + 1, bz = zB - zA + 1;
    // valores suavizados (média 3×3×3) para reduzir o ruído antes do limiar do vítreo
    const vals = new Float32Array(bx * by * bz);
    for (let z = zA; z <= zB; z++) for (let y = yMin; y <= yMax; y++) for (let x = xa; x <= xb; x++) vals[((z - zA) * by + (y - yMin)) * bx + (x - xa)] = vol[(z * ny + y) * nx + x];
    const sm3 = boxBlur3(vals, bx, by, bz);
    const m = new Uint8Array(bx * by * bz);
    for (let z = zA; z <= zB; z++) for (let x = xa; x <= xb; x++) {
      const y0 = S.yHit[z * nx + x]; if (y0 < 0) continue;
      const yb = bone[z * nx + x];
      const yLim = Math.min(yMax, Number.isFinite(yb) ? Math.floor(yb / sy) - 1 : yMax);
      for (let y = Math.max(y0, yMin); y <= yLim; y++) {
        const i = ((z - zA) * by + (y - yMin)) * bx + (x - xa);
        const v = sm3[i];
        if (v >= -25 && v <= 65) m[i] = 1;
      }
    }
    const dt = edt3d(m, bx, by, bz, sx, sy, sz);
    let bv = 0, bi = -1;
    for (let i = 0; i < dt.length; i++) if (dt[i] > bv) { bv = dt[i]; bi = i; }
    if (bi < 0 || bv < 6.5 || bv > 16) { eyes.push(null); continue; }
    const ex = bi % bx, ey = Math.floor(bi / bx) % by, ez = Math.floor(bi / (bx * by));
    eyes.push({ x: xa + ex, y: yMin + ey, z: zA + ez, r: bv });
  }
  const eyesOk = eyes[0] && eyes[1];
  if (!eyesOk) throw new Error('noeyes');
  const [e1, e2] = eyes;
  const sep = Math.abs(e1.x - e2.x) * sx;
  const dzE = Math.abs(e1.z - e2.z) * sz;
  const eyeZ = (e1.z + e2.z) / 2;
  const noseBelow = (eyeZ - nose.z) * sz;
  if (sep < 42 || sep > 85 || dzE > 15 || noseBelow < 15 || noseBelow > 70) throw new Error('noface');

  // perfil da linha média para boca e mento
  const prof = new Float32Array(nz).fill(NaN);
  const r4 = Math.max(1, Math.round(4 / sx));
  const tmp = [];
  for (let z = 0; z < nz; z++) {
    tmp.length = 0;
    for (let x = Math.round(mx) - r4; x <= Math.round(mx) + r4; x++) { if (x < 0 || x >= nx) continue; const v = d0[z * nx + x]; if (v === v) tmp.push(v); }
    if (tmp.length) { tmp.sort((a, b) => a - b); prof[z] = tmp[tmp.length >> 1]; }
  }
  const zmm = (mm) => Math.round(nose.z - mm / sz);
  const argExt = (z0, z1, sign) => { // sign=+1 busca máximo de profundidade (recesso); -1 mínimo (proeminência)
    let bz = -1, bv = sign > 0 ? -Infinity : Infinity;
    for (let z = Math.max(0, Math.min(z0, z1)); z <= Math.min(nz - 1, Math.max(z0, z1)); z++) {
      const v = prof[z]; if (v !== v) continue;
      if (sign > 0 ? v > bv : v < bv) { bv = v; bz = z; }
    }
    return bz;
  };
  const lowest = (() => { for (let z = 0; z < nz; z++) if (prof[z] === prof[z]) return z; return nz; })();
  let mouth = null, chin = null;
  // perfil suavizado (σ ≈ 1 mm) para achar a rima labial: recesso entre duas proeminências (lábios)
  const ps = new Float32Array(nz).fill(NaN);
  const rr = Math.max(1, Math.round(1 / sz));
  for (let z = 0; z < nz; z++) { let sum = 0, c = 0; for (let d = -rr; d <= rr; d++) { const v = prof[z + d]; if (z + d >= 0 && z + d < nz && v === v) { sum += v; c++; } } if (c) ps[z] = sum / c; }
  const zSub = argExt(zmm(25), zmm(5), +1);
  if (zSub > lowest + Math.round(15 / sz)) {
    const zLo = Math.max(lowest + 1, zSub - Math.round(40 / sz)), zHi = zSub - Math.round(4 / sz);
    const win = Math.round(12 / sz);
    let best = null;
    for (let z = zLo; z <= zHi; z++) {
      const v = ps[z]; if (v !== v) continue;
      if (!(v >= ps[z - 1] && v >= ps[z + 1])) continue; // máximo local de profundidade (recesso)
      let up = Infinity, dn = Infinity;
      for (let k = 1; k <= win; k++) { const a1 = ps[z + k], b1 = ps[z - k]; if (a1 === a1 && a1 < up) up = a1; if (b1 === b1 && b1 < dn) dn = b1; }
      const prom = v - Math.max(up, dn);
      if (prom < 0.6) continue;
      const expected = zSub - 20 / sz;
      const score = prom - Math.abs(z - expected) * sz * 0.05;
      if (!best || score > best.score) best = { z, score };
    }
    if (best) {
      mouth = { z: best.z, x: Math.round(mx), d: prof[best.z] };
      const zC = argExt(best.z - Math.round(50 / sz), best.z - Math.round(15 / sz), -1);
      if (zC > lowest + Math.round(4 / sz) && zC < best.z - Math.round(15 / sz) + 1) chin = { z: zC, x: Math.round(mx), d: prof[zC] };
    }
  }
  if (!mouth) notes.push('mouth');
  if (!chin) notes.push('chin');
  return { mx, nose, eyes: [e1, e2], eyeZ, mouth, chin, widths, lowest };
}

// ---------- 3. Superfície genérica ----------
function fitBase(d0, W, nz, nx, sz, sx, mx, eyeZ) {
  const terms = [];
  for (let i = 0; i <= 3; i++) for (let j = 0; i + j <= 3; j++) terms.push([i, j]);
  const nt = terms.length;
  const pts = [];
  const step = Math.max(1, Math.round(1.5 / Math.min(sx, sz)));
  for (let z = 0; z < nz; z += step) for (let x = 0; x < nx; x += step) {
    const k = z * nx + x;
    if (W[k] > 0.01 && d0[k] === d0[k]) pts.push([(x - mx) * sx / 100, (z - eyeZ) * sz / 100, d0[k], W[k]]);
  }
  if (pts.length < nt * 4) return null;
  const phi = (u, v, f) => { for (let a = 0; a < nt; a++) f[a] = Math.pow(u, terms[a][0]) * Math.pow(v, terms[a][1]); return f; };
  const f = new Float64Array(nt);
  let coef = new Float64Array(nt);
  const target = pts.map((p) => p[2]);
  for (let it = 0; it < 7; it++) {
    const A = Array.from({ length: nt }, () => new Float64Array(nt)), b = new Float64Array(nt);
    for (let n = 0; n < pts.length; n++) {
      phi(pts[n][0], pts[n][1], f);
      const w = pts[n][3], t = target[n];
      for (let a = 0; a < nt; a++) { b[a] += w * f[a] * t; for (let c = a; c < nt; c++) A[a][c] += w * f[a] * f[c]; }
    }
    for (let a = 0; a < nt; a++) { A[a][a] += 1e-6; for (let c = 0; c < a; c++) A[a][c] = A[c][a]; }
    coef = solve(A.map((r) => Array.from(r)), Array.from(b));
    for (let n = 0; n < pts.length; n++) {
      phi(pts[n][0], pts[n][1], f);
      let m = 0; for (let a = 0; a < nt; a++) m += coef[a] * f[a];
      target[n] = clamp(pts[n][2], m - 1.5, m + 1.5);
    }
  }
  const poly = new Float32Array(nz * nx).fill(NaN), res = new Float32Array(nz * nx).fill(NaN);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const k = z * nx + x;
    phi((x - mx) * sx / 100, (z - eyeZ) * sz / 100, f);
    let m = 0; for (let a = 0; a < nt; a++) m += coef[a] * f[a];
    poly[k] = m;
    if (W[k] > 0.01 && d0[k] === d0[k]) res[k] = clamp(d0[k] - m, -1.5, 1.5);
  }
  const rs = blur2D(res, nz, nx, 20 / sz, 20 / sx);
  const out = new Float32Array(nz * nx);
  for (let k = 0; k < nz * nx; k++) out[k] = poly[k] + (rs[k] === rs[k] ? rs[k] : 0);
  return out;
}

// Relevo de manequim (mm de protrusão), idêntico para todos os pacientes
export function genericRelief(du, dv) {
  let r = 0;
  // nariz: raiz em -8 mm, ponta em -40 mm, base em -48 mm (em relação à linha dos olhos)
  if (dv < -6 && dv > -49) {
    let p;
    if (dv >= -40) p = 12.5 * Math.pow((-8 - Math.min(dv, -8)) / 32, 1.3);
    else p = 12.5 * (1 - (-40 - dv) / 9);
    const s = 6 + 0.3 * p;
    r += p * Math.exp(-0.5 * (du / s) ** 2);
  }
  r += 1.5 * Math.exp(-0.5 * ((dv - 14) / 5) ** 2) * Math.exp(-0.5 * (du / 40) ** 2); // arcos superciliares
  r -= 3.0 * Math.exp(-0.5 * (((Math.abs(du) - 32) / 12) ** 2 + (dv / 8) ** 2)); // fossas orbitárias
  r += 3.5 * Math.exp(-0.5 * ((dv + 58) / 3.5) ** 2) * Math.exp(-0.5 * (du / 17) ** 2); // lábio superior
  r += 3.5 * Math.exp(-0.5 * ((dv + 68) / 3.5) ** 2) * Math.exp(-0.5 * (du / 16) ** 2); // lábio inferior
  r -= 1.5 * Math.exp(-0.5 * ((dv + 63) / 1.2) ** 2) * Math.exp(-0.5 * (du / 22) ** 2); // rima labial
  r += 4.0 * Math.exp(-0.5 * ((dv + 95) / 9) ** 2) * Math.exp(-0.5 * (du / 18) ** 2); // mento
  return r;
}

/**
 * Executa a desidentificação in-place no volume canônico.
 * Retorna relatório com pontos de referência e contagens.
 */
export function deface(V, opts = {}) {
  const { vol, nx, ny, nz, sx, sy, sz } = V;
  const notes = [];
  const rng = makeRng(opts.seed ?? (Math.random() * 4294967296));
  const S = analyzeSkin(V);
  const bone = findBoneDepth(V, S);
  const L = detectLandmarks(V, S, bone, notes);
  const { d0 } = S;
  const { mx, eyeZ } = L;

  // região facial e pesos
  const zTop = Math.min(nz - 1, eyeZ + 40 / sz);
  const zBot = Math.max(0, L.chin ? L.chin.z - 15 / sz : eyeZ - 125 / sz);
  const W = new Float32Array(nz * nx);
  const rowMin = new Float32Array(nz).fill(NaN);
  for (let z = 0; z < nz; z++) {
    let m = Infinity;
    for (let x = 0; x < nx; x++) { const v = d0[z * nx + x]; if (v === v && Math.abs(x - mx) * sx < 70 && v < m) m = v; }
    if (m < Infinity) rowMin[z] = m;
  }
  for (let z = Math.floor(zBot); z <= Math.ceil(zTop); z++) {
    if (z < 0 || z >= nz) continue;
    const wz = Math.min(clamp((zTop - z) * sz / 10, 0, 1), zBot <= 0 ? 1 : clamp((z - zBot) * sz / 8, 0, 1));
    const width = L.widths[z];
    const hw = Math.min(64, width === width ? 0.45 * width : 64);
    for (let x = 0; x < nx; x++) {
      const k = z * nx + x;
      const v = d0[k]; if (v !== v) continue;
      const du = Math.abs(x - mx) * sx;
      if (du > hw) continue;
      const wl = clamp((hw - du) / 12, 0, 1);
      const back = v - rowMin[z];
      let wf = clamp((32 - back) / 10, 0, 1);
      // abaixo do mento só entra o que ainda é mento/mandíbula (exclui o pescoço)
      if (L.chin && z < L.chin.z) wf *= clamp((L.chin.d + 12 - v) / 6, 0, 1);
      const w = wz * wl * wf;
      if (w > 0) W[k] = 0.5 - 0.5 * Math.cos(Math.PI * w);
    }
  }

  const base = fitBase(d0, W, nz, nx, sz, sx, mx, eyeZ);
  if (!base) throw new Error('noface');
  const dRef = blur2D(d0, nz, nx, 5 / sz, 5 / sx); // referência suavizada (ignora cavidades pequenas, ex.: narinas)
  const dF = new Float32Array(nz * nx).fill(NaN);
  const limit = new Float32Array(nz * nx).fill(Infinity);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const k = z * nx + x;
    if (W[k] <= 0) continue;
    const du = (x - mx) * sx, dv = (z - eyeZ) * sz;
    let d1 = base[k] - genericRelief(du, dv);
    // limita o acréscimo de tecido: até 14 mm na pirâmide nasal genérica, 6 mm no restante
    const noseZone = dv < -4 && dv > -52 && Math.abs(du) < 16;
    const maxAdd = noseZone ? 14 : 6;
    const ref = dRef[k] === dRef[k] ? Math.min(d0[k], dRef[k]) : d0[k];
    if (d1 < ref - maxAdd) d1 = ref - maxAdd;
    dF[k] = W[k] * d1 + (1 - W[k]) * d0[k];
    let lim = bone[k] - 1.0;
    for (const e of L.eyes) {
      const ddx = (x - e.x) * sx, ddz = (z - e.z) * sz, R = Math.max(e.r + 1.0, 12.5); // raio anatômico mínimo do globo
      const q = R * R - ddx * ddx - ddz * ddz;
      if (q > 0) lim = Math.min(lim, e.y * sy - Math.sqrt(q) - 2.5);
    }
    limit[k] = lim;
  }
  // acolchoamento liso onde a face genérica invadiria osso ou globos
  const exc = new Float32Array(nz * nx);
  for (let k = 0; k < nz * nx; k++) if (dF[k] === dF[k]) exc[k] = Math.max(0, dF[k] - limit[k]);
  const excM = maxFilter2D(exc, nz, nx, Math.round(4 / sz), Math.round(4 / sx));
  const excS = blur2D(excM, nz, nx, 3 / sz, 3 / sx);
  for (let k = 0; k < nz * nx; k++) {
    if (dF[k] !== dF[k]) continue;
    const e = excS[k] === excS[k] ? excS[k] : 0;
    dF[k] = Math.min(dF[k] - e, limit[k]);
  }

  // amostras do próprio exame: ar anterior e partes moles subcutâneas
  const airS = [], tisS = [];
  for (let t = 0; t < 60000 && (airS.length < 8000 || tisS.length < 8000); t++) {
    const z = Math.floor(rng() * nz), x = Math.floor(rng() * nx);
    const k = z * nx + x;
    const y0 = S.yHit[k]; if (y0 < 0) continue;
    const ya = y0 - Math.round((3 + rng() * 8) / sy);
    if (ya >= 0 && airS.length < 8000) { const v = vol[(z * ny + ya) * nx + x]; if (v < -800) airS.push(v); }
    const yt = y0 + Math.round((1 + rng() * 3) / sy);
    if (yt < ny && tisS.length < 8000 && W[k] > 0) { const v = vol[(z * ny + yt) * nx + x]; if (v > -150 && v < 100) tisS.push(v); }
  }
  if (airS.length < 50) for (let i = 0; i < 200; i++) airS.push(-1000 + Math.round((rng() - 0.5) * 30));
  if (tisS.length < 50) for (let i = 0; i < 200; i++) tisS.push(Math.round(-40 + (rng() - 0.5) * 120));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const inGlobe = (x, y, z) => {
    for (const e of L.eyes) {
      const dx = (x - e.x) * sx, dy = (y - e.y) * sy, dz = (z - e.z) * sz, R = Math.max(e.r + 1.0, 12.5);
      if (dx * dx + dy * dy + dz * dz < R * R) return true;
    }
    return false;
  };
  if (opts.beforeWrite) opts.beforeWrite({ mx: L.mx, noseZ: L.nose.z, eyeZ: L.eyeZ });
  const cm = opts.changedMask || null;
  // reescrita dos voxels: envelope pele original <-> pele nova, ±2 voxels
  let changed = 0, sealed = 0, boneTouched = 0;
  const margin = Math.ceil(0.8 / sy);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const k = z * nx + x;
    if (!(W[k] > 0.001) || d0[k] !== d0[k] || dF[k] !== dF[k]) continue;
    const a = d0[k], f = dF[k];
    const lo = Math.min(a, f), hi = Math.max(a, f);
    let y0 = Math.floor(lo / sy) - 2, y1 = Math.ceil(hi / sy) + 2;
    const lim = limit[k];
    const yLim = Number.isFinite(lim) ? Math.floor((lim + 1.0) / sy) - margin : ny - 1;
    y0 = Math.max(0, y0); y1 = Math.min(ny - 1, y1, yLim);
    const o = z * ny * nx + x;
    for (let y = y0; y <= y1; y++) {
      const i = o + y * nx;
      const v = vol[i];
      if (v > BONE_T) continue;
      if (inGlobe(x, y, z)) continue; // nunca altera os globos oculares
      const pos = y * sy;
      const fr = clamp((pos - f) / sy + 0.5 + (rng() - 0.5) * 0.5, 0, 1);
      const nv = Math.round(fr * pick(tisS) + (1 - fr) * pick(airS));
      if (nv !== v) { vol[i] = nv; changed++; if (cm) cm[i] = 1; }
    }
    // veda cavidades aéreas logo atrás da nova pele (ex.: vestíbulo nasal exposto)
    const ys = Math.ceil(f / sy) + 3, ye = Math.min(ny - 1, Math.floor((f + 5) / sy), yLim);
    if (f > a + 0.5) for (let y = ys; y <= ye; y++) {
      const i = o + y * nx;
      if (vol[i] < -300 && !inGlobe(x, y, z)) { vol[i] = pick(tisS); changed++; sealed++; if (cm) cm[i] = 1; }
    }
  }
  return {
    landmarks: {
      eyes: L.eyes.map((e) => ({ x: e.x, y: e.y, z: e.z, r: +e.r.toFixed(1) })),
      nose: { x: L.nose.x, y: L.nose.d / sy, z: L.nose.z, prot: +L.nose.prot.toFixed(1) },
      mouth: L.mouth ? { x: L.mouth.x, y: L.mouth.d / sy, z: L.mouth.z } : null,
      chin: L.chin ? { x: L.chin.x, y: L.chin.d / sy, z: L.chin.z } : null,
      mx: L.mx, eyeZ: L.eyeZ,
    },
    changed, sealed, boneTouched, notes,
    surfaces: { d0, dF, W, nz, nx },
  };
}
