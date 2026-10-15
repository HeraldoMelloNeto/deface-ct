// Deface CT — decodificação de pixels (nativo, RLE, JPEG Lossless, JPEG-LS, JPEG 2000)
import { TS } from './dicom.js';
import openjpegFactory from '../node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.js';
import charlsFactory from '../node_modules/@cornerstonejs/codec-charls/dist/charlswasm_decode.js';
import openjpegWasm from '../node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm';
import charlsWasm from '../node_modules/@cornerstonejs/codec-charls/dist/charlswasm_decode.wasm';
import { Decoder as LosslessDecoder } from 'jpeg-lossless-decoder-js';

let ojp = null, cls = null;

async function getOpenJPEG() {
  if (!ojp) ojp = await openjpegFactory({ wasmBinary: openjpegWasm, locateFile: (f) => f, print: () => {}, printErr: () => {} });
  return ojp;
}
async function getCharLS() {
  if (!cls) cls = await charlsFactory({ wasmBinary: charlsWasm, locateFile: (f) => f, print: () => {}, printErr: () => {} });
  return cls;
}

export const SUPPORTED_TS = new Set([TS.IMPLICIT, TS.EXPLICIT, TS.DEFLATED, TS.RLE, TS.JPEG_LL14, TS.JPEG_LL14SV1, TS.JLS_LOSSLESS, TS.JLS_NEAR, TS.J2K_LOSSLESS, TS.J2K]);

export function tsName(ts) {
  return ({
    [TS.IMPLICIT]: 'Implicit VR LE', [TS.EXPLICIT]: 'Explicit VR LE', [TS.DEFLATED]: 'Deflate', [TS.RLE]: 'RLE',
    [TS.JPEG_LL14]: 'JPEG Lossless', [TS.JPEG_LL14SV1]: 'JPEG Lossless SV1', [TS.JLS_LOSSLESS]: 'JPEG-LS', [TS.JLS_NEAR]: 'JPEG-LS near-lossless',
    [TS.J2K_LOSSLESS]: 'JPEG 2000 lossless', [TS.J2K]: 'JPEG 2000', [TS.JPEG_BASELINE]: 'JPEG baseline', [TS.JPEG_EXT]: 'JPEG extended', [TS.BIG]: 'Big Endian',
  })[ts] || ts;
}

function concatFragments(frags) {
  if (frags.length === 1) return frags[0];
  let n = 0; for (const f of frags) n += f.length;
  const out = new Uint8Array(n); let p = 0;
  for (const f of frags) { out.set(f, p); p += f.length; }
  return out;
}

// Normaliza amostras para Int32Array com sinal correto (valores armazenados)
function normalize(raw16, n, bitsStored, signed) {
  const out = new Int32Array(n);
  const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  const signBit = 1 << (bitsStored - 1);
  for (let i = 0; i < n; i++) {
    let v = raw16[i] & mask;
    if (signed && (v & signBit)) v -= mask + 1;
    out[i] = v;
  }
  return out;
}

function decodeRLE(data, n, bitsAllocated) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nseg = dv.getUint32(0, true);
  const bpp = bitsAllocated / 8;
  if (nseg !== bpp) throw new Error('RLE com número de segmentos inesperado');
  const offs = [];
  for (let s = 0; s < nseg; s++) offs.push(dv.getUint32(4 + 4 * s, true));
  const planes = [];
  for (let s = 0; s < nseg; s++) {
    const start = offs[s], end = s + 1 < nseg ? offs[s + 1] : data.length;
    const out = new Uint8Array(n);
    let p = start, o = 0;
    while (o < n && p < end) {
      const c = data[p++] << 24 >> 24;
      if (c >= 0) { const k = c + 1; for (let i = 0; i < k && o < n; i++) out[o++] = data[p++]; }
      else if (c !== -128) { const k = 1 - c; const b = data[p++]; for (let i = 0; i < k && o < n; i++) out[o++] = b; }
    }
    planes.push(out);
  }
  if (bpp === 1) return planes[0];
  const res = new Uint16Array(n);
  for (let i = 0; i < n; i++) res[i] = (planes[0][i] << 8) | planes[1][i];
  return res;
}

/**
 * Decodifica o Pixel Data de um quadro único.
 * Retorna Int32Array (valores armazenados, já com sinal).
 */
export async function decodePixels(ds, info) {
  const { rows, cols, bitsAllocated, bitsStored, signed } = info;
  const n = rows * cols;
  const el = ds.pixelEl;
  const ts = ds.ts;
  if (!el) throw new Error('Sem Pixel Data');
  if (!el.encapsulated) {
    if (bitsAllocated === 16) {
      if (el.value.length < n * 2) throw new Error('Pixel Data menor que o esperado');
      const b = el.value;
      const raw = new Uint16Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 2) raw[i] = b[j] | (b[j + 1] << 8);
      return normalize(raw, n, bitsStored, signed);
    }
    if (bitsAllocated === 8) {
      if (el.value.length < n) throw new Error('Pixel Data menor que o esperado');
      return normalize(el.value, n, bitsStored, signed);
    }
    throw new Error('BitsAllocated ' + bitsAllocated + ' não suportado');
  }
  const data = concatFragments(el.fragments);
  if (ts === TS.RLE) return normalize(decodeRLE(data, n, bitsAllocated), n, bitsStored, signed);
  if (ts === TS.J2K || ts === TS.J2K_LOSSLESS) {
    const m = await getOpenJPEG();
    const d = new m.J2KDecoder();
    try {
      d.getEncodedBuffer(data.length).set(data);
      d.decode();
      const fi = d.getFrameInfo();
      if (fi.width !== cols || fi.height !== rows) throw new Error('Dimensão J2K diferente do cabeçalho');
      const buf = d.getDecodedBuffer();
      const raw = fi.bitsPerSample > 8 ? (fi.isSigned ? new Int16Array(buf.buffer, buf.byteOffset, n) : new Uint16Array(buf.buffer, buf.byteOffset, n)) : (fi.isSigned ? new Int8Array(buf.buffer, buf.byteOffset, n) : new Uint8Array(buf.buffer, buf.byteOffset, n));
      const out = new Int32Array(n);
      if (fi.isSigned === signed || fi.bitsPerSample <= 8) for (let i = 0; i < n; i++) out[i] = raw[i];
      else return normalize(new Uint16Array(raw.buffer, raw.byteOffset, n).slice(), n, bitsStored, signed);
      return out;
    } finally { d.delete(); }
  }
  if (ts === TS.JLS_LOSSLESS || ts === TS.JLS_NEAR) {
    const m = await getCharLS();
    const d = new m.JpegLSDecoder();
    try {
      d.getEncodedBuffer(data.length).set(data);
      d.decode();
      const fi = d.getFrameInfo();
      if (fi.width !== cols || fi.height !== rows) throw new Error('Dimensão JPEG-LS diferente do cabeçalho');
      const buf = d.getDecodedBuffer();
      const raw = fi.bitsPerSample > 8 ? new Uint16Array(buf.buffer, buf.byteOffset, n).slice() : new Uint8Array(buf.buffer, buf.byteOffset, n).slice();
      return normalize(raw, n, bitsStored, signed);
    } finally { d.delete(); }
  }
  if (ts === TS.JPEG_LL14 || ts === TS.JPEG_LL14SV1) {
    const dec = new LosslessDecoder();
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const out = dec.decompress(ab, 0, data.byteLength);
    const raw = bitsAllocated === 16 ? new Uint16Array(out.buffer || out, 0, n) : new Uint8Array(out.buffer || out, 0, n);
    return normalize(raw, n, bitsStored, signed);
  }
  throw new Error('Compressão não suportada: ' + tsName(ts));
}
