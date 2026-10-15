// Montagem do volume canônico a partir da série e regravação dos cortes desidentificados
import {
  TAG, T, parseDicom, getStr, getNum, getNums, getUS, findEl, setEl, setStr, removeEl, strBytes, usBytes,
  writeDicom, newUID,
} from './dicom.js';
import { decodePixels } from './codecs.js';

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

/** Geometria canônica a partir da orientação da série */
export function geometry(info0, nslices, spacing) {
  const r = info0.iop.slice(0, 3), c = info0.iop.slice(3, 6);
  const rows = info0.rows, cols = info0.cols;
  const ps = info0.ps; // [entre linhas, entre colunas]
  const colsAreX = Math.abs(r[0]) >= Math.abs(c[0]);
  let nx, ny, sx, sy, flipX, flipY;
  if (colsAreX) { nx = cols; ny = rows; sx = ps[1]; sy = ps[0]; flipX = r[0] < 0; flipY = c[1] < 0; }
  else { nx = rows; ny = cols; sx = ps[0]; sy = ps[1]; flipX = c[0] < 0; flipY = r[1] < 0; }
  return { rows, cols, nx, ny, nz: nslices, sx, sy, sz: spacing, colsAreX, flipX, flipY, normal: cross(r, c) };
}

// índice no corte original (linha*cols + coluna) para cada (x,y) canônico
export function buildIndexMap(G) {
  const map = new Int32Array(G.nx * G.ny);
  for (let y = 0; y < G.ny; y++) for (let x = 0; x < G.nx; x++) {
    const xx = G.flipX ? G.nx - 1 - x : x, yy = G.flipY ? G.ny - 1 - y : y;
    let row, col;
    if (G.colsAreX) { col = xx; row = yy; } else { row = xx; col = yy; }
    map[y * G.nx + x] = row * G.cols + col;
  }
  return map;
}

function cloneHeader(elements) {
  const out = [];
  for (const el of elements) {
    if (el.tag === TAG.PixelData) continue;
    if ((el.tag & 0xffff) === 0) continue; // comprimento de grupo (obsoleto; ficaria incorreto após edição)
    const c = { tag: el.tag, vr: el.vr };
    if (el.items) c.items = el.items.map((it) => cloneHeader(it));
    else c.value = el.value ? el.value.slice() : new Uint8Array(0);
    out.push(c);
  }
  return out;
}

/**
 * Lê e decodifica a série escolhida em ordem inferior->superior.
 * readEntry(entry) => Promise<Uint8Array>
 */
export async function loadVolume(chosen, readEntry, onProgress) {
  const slices = chosen.slices.slice();
  const info0 = slices[0].info;
  const G0 = geometry(info0, slices.length, chosen.ev.spacing);
  const n = G0.normal;
  slices.sort((a, b) => dot(a.info.ipp, n) - dot(b.info.ipp, n));
  if (n[2] < 0) slices.reverse(); // garante z inferior -> superior
  const G = geometry(info0, slices.length, chosen.ev.spacing);
  const { nx, ny, nz } = G;
  const map = buildIndexMap(G);
  const vol = new Int16Array(nx * ny * nz);
  const headers = [];
  const pix = [];
  let simple = true;
  let stored = null;
  for (let z = 0; z < nz; z++) {
    const bytes = await readEntry(slices[z].entry);
    const ds = parseDicom(bytes);
    const pixelEl = findEl(ds.elements, TAG.PixelData);
    const bitsAllocated = getUS(ds, TAG.BitsAllocated, 16);
    const bitsStored = getUS(ds, TAG.BitsStored, bitsAllocated);
    const signed = getUS(ds, TAG.PixelRepresentation, 0) === 1;
    const spp = getUS(ds, TAG.SamplesPerPixel, 1);
    const rows = getUS(ds, TAG.Rows, 0), cols = getUS(ds, TAG.Columns, 0);
    if (spp !== 1) throw new Error('rgb');
    if (bitsAllocated !== 16) throw new Error('bits');
    if (rows !== G.rows || cols !== G.cols) throw new Error('inconsistent');
    const m = getNum(ds, TAG.RescaleSlope, 1) || 1;
    const b = getNum(ds, TAG.RescaleIntercept, 0) || 0;
    const sv = await decodePixels({ pixelEl, ts: ds.ts }, { rows, cols, bitsAllocated, bitsStored, signed });
    if (m !== 1 || !Number.isInteger(b)) {
      if (simple) { simple = false; stored = new Array(nz).fill(null); }
    }
    if (!simple) stored[z] = sv;
    const o = z * nx * ny;
    for (let k = 0; k < nx * ny; k++) {
      let hu = sv[map[k]] * m + b;
      if (hu < -32768) hu = -32768; else if (hu > 32767) hu = 32767;
      vol[o + k] = Math.round(hu);
    }
    if (simple) {
      for (let k = 0; k < nx * ny; k++) if (vol[o + k] !== sv[map[k]] + b) { simple = false; stored = new Array(nz).fill(null); break; }
      if (!simple) stored[z] = sv;
    }
    headers.push({ elements: cloneHeader(ds.elements), explicit: ds.explicit, sopClass: getStr(ds, TAG.SOPClassUID) || getStr({ elements: ds.meta }, TAG.MediaStorageSOPClassUID) });
    pix.push({ m, b, bitsStored, signed });
    if (onProgress && (z % 8 === 0 || z === nz - 1)) onProgress((z + 1) / nz);
  }
  if (!simple) {
    // se a série deixou de ser simples no meio, recompõe os cortes anteriores a partir do volume
    for (let z = 0; z < nz; z++) if (!stored[z]) {
      const sv = new Int32Array(G.rows * G.cols); const o = z * nx * ny; const { m, b } = pix[z];
      for (let k = 0; k < nx * ny; k++) sv[map[k]] = Math.round((vol[o + k] - b) / m);
      stored[z] = sv;
    }
  }
  return { vol, G, map, headers, pix, simple, stored, nx, ny, nz, sx: G.sx, sy: G.sy, sz: G.sz };
}

// ---------- anonimização ----------
const REMOVE = [
  [0x0010, 0x0030], [0x0010, 0x0032], [0x0010, 0x1000], [0x0010, 0x1001], [0x0010, 0x1002], [0x0010, 0x1005],
  [0x0010, 0x1040], [0x0010, 0x1060], [0x0010, 0x2154], [0x0010, 0x2155], [0x0010, 0x1090], [0x0010, 0x21b0],
  [0x0010, 0x4000], [0x0010, 0x0050], [0x0010, 0x2180], [0x0010, 0x1080], [0x0010, 0x2160], [0x0010, 0x0021],
  [0x0010, 0x0033], [0x0010, 0x0034], [0x0010, 0x0035], [0x0010, 0x0101], [0x0010, 0x0102], [0x0010, 0x1100],
  [0x0008, 0x0080], [0x0008, 0x0081], [0x0008, 0x0082], [0x0008, 0x1040], [0x0008, 0x1041], [0x0008, 0x1010],
  [0x0008, 0x0090], [0x0008, 0x009c], [0x0008, 0x009d], [0x0008, 0x0092], [0x0008, 0x0094], [0x0008, 0x0096], [0x0008, 0x1048], [0x0008, 0x1049],
  [0x0008, 0x1050], [0x0008, 0x1052], [0x0008, 0x1060], [0x0008, 0x1062], [0x0008, 0x1070], [0x0008, 0x1072],
  [0x0008, 0x1080], [0x0008, 0x1084], [0x0008, 0x1110], [0x0008, 0x1111], [0x0008, 0x1120], [0x0008, 0x1140],
  [0x0008, 0x2111], [0x0008, 0x0014], [0x0008, 0x0201], [0x0018, 0x1000], [0x0018, 0x1004], [0x0018, 0x1005],
  [0x0018, 0x1007], [0x0018, 0x1008], [0x0018, 0x9424], [0x0020, 0x4000], [0x0020, 0x9158], [0x0032, 0x1032],
  [0x0032, 0x1033], [0x0032, 0x4000], [0x0032, 0x1021], [0x0032, 0x1031], [0x0038, 0x0010], [0x0038, 0x0011],
  [0x0038, 0x0300], [0x0038, 0x0400], [0x0038, 0x0500], [0x0038, 0x0004], [0x0038, 0x0060], [0x0038, 0x4000],
  [0x0040, 0x0006], [0x0040, 0x0241], [0x0040, 0x0242], [0x0040, 0x0243], [0x0040, 0x0253], [0x0040, 0x0275],
  [0x0040, 0x1001], [0x0040, 0x1004], [0x0040, 0x1005], [0x0040, 0x1010], [0x0040, 0x1011], [0x0040, 0x1101],
  [0x0040, 0x1102], [0x0040, 0x1103], [0x0040, 0x1400], [0x0040, 0x2001], [0x0040, 0x2008], [0x0040, 0x2009],
  [0x0040, 0x2010], [0x0040, 0x2016], [0x0040, 0x2017], [0x0040, 0x2400], [0x0040, 0x3001], [0x0040, 0xa073],
  [0x0040, 0xa075], [0x0040, 0xa078], [0x0040, 0xa07a], [0x0040, 0xa07c], [0x0040, 0xa088], [0x0040, 0xa123],
  [0x0040, 0xa124], [0x0040, 0xa730], [0x0040, 0x4037], [0x0040, 0x4036], [0x0040, 0x0007], [0x0400, 0x0561],
  [0x4008, 0x0114], [0x4008, 0x0119], [0x4008, 0x011a], [0x4008, 0x0202], [0x0088, 0x0140], [0x0018, 0x9445],
].map(([g, e]) => T(g, e));
const REMOVE_SET = new Set(REMOVE);

function anonymizeRec(elements, depth) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const g = el.tag >>> 16;
    if ((g & 1) === 1 || REMOVE_SET.has(el.tag)) { elements.splice(i, 1); continue; }
    if (el.vr === 'PN' && el.tag !== TAG.PatientName) { el.value = new Uint8Array(0); continue; }
    if (el.items) for (const it of el.items) anonymizeRec(it, depth + 1);
  }
}

/** Gera o DICOM desidentificado de um corte. */
export function buildSlice(V, z, ctx) {
  const { G, map, vol, headers, pix, simple, stored, nx, ny } = V;
  const h = headers[z];
  const elements = cloneHeader(h.elements);
  const { m, b, bitsStored, signed } = pix[z];
  const lo = signed ? -(2 ** (bitsStored - 1)) : 0, hi = signed ? 2 ** (bitsStored - 1) - 1 : 2 ** bitsStored - 1;
  const n = G.rows * G.cols;
  const out = new Uint8Array(n * 2);
  const o = z * nx * ny;
  const st = stored ? stored[z] : null;
  const chg = ctx.changedMask;
  for (let k = 0; k < nx * ny; k++) {
    const idx = map[k];
    let sv;
    if (simple) sv = vol[o + k] - b;
    else sv = chg && chg[o + k] ? Math.round((vol[o + k] - b) / m) : st[idx];
    if (sv < lo) sv = lo; else if (sv > hi) sv = hi;
    out[idx * 2] = sv & 255; out[idx * 2 + 1] = (sv >> 8) & 255;
  }
  const sop = newUID();
  setEl(elements, TAG.PixelData, 'OW', out);
  setEl(elements, TAG.BitsAllocated, 'US', usBytes(16));
  removeEl(elements, TAG.SmallestImagePixelValue);
  removeEl(elements, TAG.LargestImagePixelValue);
  removeEl(elements, T(0x0028, 0x0108)); removeEl(elements, T(0x0028, 0x0109));
  removeEl(elements, T(0x0088, 0x0200)); // ícone
  removeEl(elements, TAG.PlanarConfiguration);
  setStr(elements, TAG.SOPInstanceUID, 'UI', sop);
  setStr(elements, TAG.SeriesInstanceUID, 'UI', ctx.seriesUID);
  // acrescenta o sufixo em ASCII preservando os bytes originais (mantém o conjunto de caracteres da série)
  const suffix = ctx.passthrough ? ' ANON' : ' DEFACE';
  const dEl = findEl(elements, TAG.SeriesDescription);
  let raw = dEl && dEl.value ? dEl.value : strBytes('CT', 'LO');
  let end = raw.length; while (end > 0 && (raw[end - 1] === 0x20 || raw[end - 1] === 0)) end--;
  raw = raw.subarray(0, Math.min(end, 64 - suffix.length));
  const descBytes = new Uint8Array(raw.length + suffix.length);
  descBytes.set(raw); for (let i = 0; i < suffix.length; i++) descBytes[raw.length + i] = suffix.charCodeAt(i);
  setEl(elements, TAG.SeriesDescription, 'LO', descBytes);
  const sn = getNum({ elements }, TAG.SeriesNumber, 1);
  setStr(elements, TAG.SeriesNumber, 'IS', String(Math.round(sn) + 1000));
  if (!ctx.passthrough) {
    const it = getStr({ elements }, TAG.ImageType).split('\\');
    it[0] = 'DERIVED'; if (it.length < 2) it.push('SECONDARY');
    setStr(elements, TAG.ImageType, 'CS', it.join('\\'));
  }
  setStr(elements, TAG.BurnedInAnnotation, 'CS', 'NO');
  const deriv = ctx.passthrough ? 'No facial surface detected by Deface CT 1.4; pixels unchanged' : 'Facial surface replaced by generic surface (Deface CT 1.4)';
  setStr(elements, T(0x0008, 0x2111), 'ST', deriv);
  if (ctx.anonymize) {
    anonymizeRec(elements, 0);
    setStr(elements, TAG.PatientName, 'PN', ctx.code);
    setStr(elements, TAG.PatientID, 'LO', ctx.code);
    setStr(elements, TAG.AccessionNumber, 'SH', ctx.code.slice(0, 16));
    setStr(elements, TAG.StudyID, 'SH', '1');
    setStr(elements, TAG.StudyInstanceUID, 'UI', ctx.studyUID);
    setStr(elements, TAG.FrameOfReferenceUID, 'UI', ctx.forUID);
    setStr(elements, TAG.PatientIdentityRemoved, 'CS', 'YES');
    setStr(elements, TAG.DeidentificationMethod, 'LO', ctx.passthrough ? 'Deface CT 1.4: basic header only' : 'Deface CT 1.4: facial surface + basic header');
    setStr(elements, T(0x0008, 0x2111), 'ST', deriv);
  }
  const bytes = writeDicom({ elements, explicit: h.explicit, sopClassUID: h.sopClass || '1.2.840.10008.5.1.4.1.1.2', sopInstanceUID: sop });
  return bytes;
}

export { getStr, getNums };
