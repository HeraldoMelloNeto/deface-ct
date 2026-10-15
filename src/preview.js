import { keepLargestComponent } from './render.js';
// Volumes reduzidos para renderização 3D e imagens de controle de qualidade
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Reduz o volume canônico para voxels ~isotrópicos (máx. `maxDim` por eixo), em uint8: (UH+1024)/8 */
export function makePreview(V, maxDim = 128) {
  const { vol, nx, ny, nz, sx, sy, sz } = V;
  const ext = Math.max(nx * sx, ny * sy, nz * sz);
  const p = Math.max(ext / maxDim, sx, sy, sz);
  const px = Math.max(1, Math.round(nx * sx / p)), py = Math.max(1, Math.round(ny * sy / p)), pz = Math.max(1, Math.round(nz * sz / p));
  const out = new Uint8Array(px * py * pz);
  const fx = nx / px, fy = ny / py, fz = nz / pz;
  for (let k = 0; k < pz; k++) {
    const z0 = Math.floor(k * fz), z1 = Math.max(z0 + 1, Math.floor((k + 1) * fz));
    for (let j = 0; j < py; j++) {
      const y0 = Math.floor(j * fy), y1 = Math.max(y0 + 1, Math.floor((j + 1) * fy));
      for (let i = 0; i < px; i++) {
        const x0 = Math.floor(i * fx), x1 = Math.max(x0 + 1, Math.floor((i + 1) * fx));
        // amostra 2x2x2 dentro do bloco (rápido e suficiente para a superfície)
        let s = 0, c = 0;
        const zs = [z0, Math.min(nz - 1, (z0 + z1 - 1) >> 1 | 0)], ys = [y0, Math.min(ny - 1, (y0 + y1) >> 1)], xs = [x0, Math.min(nx - 1, (x0 + x1) >> 1)];
        for (const z of zs) for (const y of ys) for (const x of xs) { let v = vol[(z * ny + y) * nx + x]; if (v < -1024) v = -1024; s += v; c++; }
        out[(k * py + j) * px + i] = clamp(Math.round((s / c + 1024) / 8), 0, 255);
      }
    }
  }
  return keepLargestComponent({ nx: px, ny: py, nz: pz, sx: nx * sx / px, sy: ny * sy / py, sz: nz * sz / pz, data: out });
}

/** Corte sagital (z × y) em x fixo e axial (y × x) em z fixo, janela [-1000, 600] UH, uint8 */
export function qcSlices(V, x, z) {
  const { vol, nx, ny, nz } = V;
  const win = (v) => clamp(Math.round((v + 1000) / 1600 * 255), 0, 255);
  x = clamp(Math.round(x), 0, nx - 1); z = clamp(Math.round(z), 0, nz - 1);
  const sag = new Uint8Array(nz * ny);
  for (let k = 0; k < nz; k++) for (let y = 0; y < ny; y++) sag[(nz - 1 - k) * ny + y] = win(vol[(k * ny + y) * nx + x]);
  const ax = new Uint8Array(ny * nx);
  const o = z * nx * ny;
  for (let i = 0; i < nx * ny; i++) ax[i] = win(vol[o + i]);
  return { sag: { w: ny, h: nz, data: sag }, ax: { w: nx, h: ny, data: ax } };
}
