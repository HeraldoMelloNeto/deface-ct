// Deface CT — leitura e escrita DICOM (Part 10), sem dependências externas
// além do fflate para Deflated Explicit VR Little Endian.
import { inflateSync } from 'fflate';

export const TS = {
  IMPLICIT: '1.2.840.10008.1.2',
  EXPLICIT: '1.2.840.10008.1.2.1',
  DEFLATED: '1.2.840.10008.1.2.1.99',
  BIG: '1.2.840.10008.1.2.2',
  RLE: '1.2.840.10008.1.2.5',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXT: '1.2.840.10008.1.2.4.51',
  JPEG_LL14: '1.2.840.10008.1.2.4.57',
  JPEG_LL14SV1: '1.2.840.10008.1.2.4.70',
  JLS_LOSSLESS: '1.2.840.10008.1.2.4.80',
  JLS_NEAR: '1.2.840.10008.1.2.4.81',
  J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
  J2K: '1.2.840.10008.1.2.4.91',
};

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const VALID_VR = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'SV', 'TM', 'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT', 'UV']);
const UNDEF = 0xffffffff;
const ITEM = 0xfffee000, ITEM_END = 0xfffee00d, SEQ_END = 0xfffee0dd;

export const T = (g, e) => ((g << 16) | e) >>> 0;
export const TAG = {
  TransferSyntaxUID: T(0x0002, 0x0010),
  MediaStorageSOPClassUID: T(0x0002, 0x0002),
  ImageType: T(0x0008, 0x0008),
  SOPClassUID: T(0x0008, 0x0016),
  SOPInstanceUID: T(0x0008, 0x0018),
  StudyDate: T(0x0008, 0x0020),
  AccessionNumber: T(0x0008, 0x0050),
  Modality: T(0x0008, 0x0060),
  StudyDescription: T(0x0008, 0x1030),
  SeriesDescription: T(0x0008, 0x103e),
  PatientName: T(0x0010, 0x0010),
  PatientID: T(0x0010, 0x0020),
  PatientBirthDate: T(0x0010, 0x0030),
  ContrastBolusAgent: T(0x0018, 0x0010),
  ContrastBolusRoute: T(0x0018, 0x1040),
  ContrastBolusVolume: T(0x0018, 0x1041),
  ContrastBolusStartTime: T(0x0018, 0x1042),
  ContrastBolusIngredient: T(0x0018, 0x1048),
  SliceThickness: T(0x0018, 0x0050),
  ConvolutionKernel: T(0x0018, 0x1210),
  StudyInstanceUID: T(0x0020, 0x000d),
  SeriesInstanceUID: T(0x0020, 0x000e),
  StudyID: T(0x0020, 0x0010),
  SeriesNumber: T(0x0020, 0x0011),
  InstanceNumber: T(0x0020, 0x0013),
  ImagePositionPatient: T(0x0020, 0x0032),
  ImageOrientationPatient: T(0x0020, 0x0037),
  FrameOfReferenceUID: T(0x0020, 0x0052),
  SamplesPerPixel: T(0x0028, 0x0002),
  PhotometricInterpretation: T(0x0028, 0x0004),
  PlanarConfiguration: T(0x0028, 0x0006),
  NumberOfFrames: T(0x0028, 0x0008),
  Rows: T(0x0028, 0x0010),
  Columns: T(0x0028, 0x0011),
  PixelSpacing: T(0x0028, 0x0030),
  BitsAllocated: T(0x0028, 0x0100),
  BitsStored: T(0x0028, 0x0101),
  HighBit: T(0x0028, 0x0102),
  PixelRepresentation: T(0x0028, 0x0103),
  SmallestImagePixelValue: T(0x0028, 0x0106),
  LargestImagePixelValue: T(0x0028, 0x0107),
  PixelPaddingValue: T(0x0028, 0x0120),
  PixelPaddingRangeLimit: T(0x0028, 0x0121),
  RescaleIntercept: T(0x0028, 0x1052),
  RescaleSlope: T(0x0028, 0x1053),
  LossyImageCompression: T(0x0028, 0x2110),
  PixelData: T(0x7fe0, 0x0010),
  PatientIdentityRemoved: T(0x0012, 0x0062),
  DeidentificationMethod: T(0x0012, 0x0063),
  BurnedInAnnotation: T(0x0028, 0x0301),
};

// Tags binários conhecidos (necessários quando a sintaxe é implícita)
const US_TAGS = new Set([TAG.SamplesPerPixel, TAG.PlanarConfiguration, TAG.Rows, TAG.Columns, TAG.BitsAllocated, TAG.BitsStored, TAG.HighBit, TAG.PixelRepresentation]);

const dec = new TextDecoder('latin1');
const enc = new TextEncoder();

export class DicomError extends Error {}

function readTag(dv, p) { return ((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true)) >>> 0; }

function vrAt(u8, p) {
  const a = u8[p], b = u8[p + 1];
  if (a < 65 || a > 90 || b < 65 || b > 90) return null;
  const s = String.fromCharCode(a, b);
  return VALID_VR.has(s) ? s : null;
}

// Converte um elemento implícito definido em sequência quando o conteúdo parece itens
function tryParseImplicitSeq(u8, dv, start, len, depth) {
  if (len < 8 || readTag(dv, start) !== ITEM) return null;
  try {
    const { items, end } = parseItems(u8, dv, start, start + len, false, depth + 1);
    if (end !== start + len) return null;
    return items;
  } catch (e) { return null; }
}

function parseItems(u8, dv, p, limit, explicit, depth) {
  const items = [];
  while (p < limit) {
    if (p + 8 > u8.length) throw new DicomError('Item truncado');
    const tag = readTag(dv, p);
    const len = dv.getUint32(p + 4, true);
    p += 8;
    if (tag === SEQ_END) return { items, end: p };
    if (tag !== ITEM) throw new DicomError('Item de sequência inválido');
    if (len === UNDEF) {
      const r = parseDataset(u8, dv, p, u8.length, explicit, depth, true);
      items.push(r.elements);
      p = r.end;
    } else {
      const r = parseDataset(u8, dv, p, p + len, explicit, depth, false);
      items.push(r.elements);
      p += len;
    }
  }
  return { items, end: p };
}

function parseDataset(u8, dv, p, limit, explicit, depth, stopAtItemEnd) {
  if (depth > 12) throw new DicomError('Aninhamento excessivo');
  const elements = [];
  while (p < limit) {
    if (p + 8 > limit && p + 8 > u8.length) break;
    if (p + 4 > u8.length) break;
    const tag = readTag(dv, p);
    if (tag === ITEM_END) { return { elements, end: p + 8 }; }
    if (tag === SEQ_END) { return { elements, end: p + 8 }; }
    let vr = null, len, hdr;
    const group = tag >>> 16;
    if (explicit && group !== 0xfffe) {
      vr = vrAt(u8, p + 4);
      if (vr === null) {
        // alguns arquivos misturam implícito em sintaxe explícita
        len = dv.getUint32(p + 4, true); hdr = 8;
      } else if (LONG_VR.has(vr)) { len = dv.getUint32(p + 8, true); hdr = 12; }
      else { len = dv.getUint16(p + 6, true); hdr = 8; }
    } else { len = dv.getUint32(p + 4, true); hdr = 8; }
    const start = p + hdr;
    const el = { tag, vr, offset: start, length: len, undefinedLength: len === UNDEF };
    if (tag === TAG.PixelData && len === UNDEF) {
      // dados encapsulados: tabela de offsets + fragmentos
      const frags = [];
      let q = start;
      let first = true;
      while (q + 8 <= u8.length) {
        const t = readTag(dv, q), l = dv.getUint32(q + 4, true);
        q += 8;
        if (t === SEQ_END) break;
        if (t !== ITEM) throw new DicomError('Fragmento de pixel inválido');
        if (q + l > u8.length) throw new DicomError('Fragmento de pixel truncado');
        if (!first) frags.push(u8.subarray(q, q + l));
        first = false;
        q += l;
      }
      el.fragments = frags;
      el.encapsulated = true;
      elements.push(el);
      p = q;
      continue;
    }
    if (vr === 'SQ' || (len === UNDEF && tag !== TAG.PixelData)) {
      if (len === UNDEF) {
        const r = parseItems(u8, dv, start, u8.length, explicit, depth + 1);
        el.items = r.items; el.vr = el.vr || 'SQ';
        elements.push(el);
        p = r.end;
      } else {
        if (start + len > u8.length) throw new DicomError('Sequência truncada');
        const r = parseItems(u8, dv, start, start + len, explicit, depth + 1);
        el.items = r.items;
        elements.push(el);
        p = start + len;
      }
      continue;
    }
    if (start + len > u8.length) {
      if (tag === TAG.PixelData) throw new DicomError('Pixel Data truncado');
      throw new DicomError('Elemento truncado');
    }
    el.value = u8.subarray(start, start + len);
    if (!explicit && group !== 0x7fe0) {
      const items = tryParseImplicitSeq(u8, dv, start, len, depth);
      if (items) { el.items = items; el.implicitSeq = true; }
    }
    elements.push(el);
    p = start + len;
    if (stopAtItemEnd === false && p >= limit) break;
  }
  return { elements, end: p };
}

export function parseDicom(buffer) {
  let u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const meta = [];
  let ts = TS.IMPLICIT;
  if (u8.length >= 132 && u8[128] === 0x44 && u8[129] === 0x49 && u8[130] === 0x43 && u8[131] === 0x4d) {
    p = 132;
    while (p + 8 <= u8.length && dv.getUint16(p, true) === 0x0002) {
      const tag = readTag(dv, p);
      const vr = vrAt(u8, p + 4) || 'UN';
      let len, hdr;
      if (LONG_VR.has(vr)) { len = dv.getUint32(p + 8, true); hdr = 12; } else { len = dv.getUint16(p + 6, true); hdr = 8; }
      if (p + hdr + len > u8.length) throw new DicomError('Cabeçalho truncado');
      const value = u8.subarray(p + hdr, p + hdr + len);
      meta.push({ tag, vr, value, length: len });
      if (tag === TAG.TransferSyntaxUID) ts = cleanStr(dec.decode(value));
      p += hdr + len;
    }
  } else {
    // sem preâmbulo: aceita somente se parece um conjunto de dados implícito
    const g = dv.getUint16(0, true);
    if (!(g === 0x0008 || g === 0x0002)) throw new DicomError('Não é DICOM');
    if (g === 0x0002) throw new DicomError('Não é DICOM');
  }
  if (ts === TS.BIG) throw new DicomError('Big Endian não suportado');
  let explicit = ts !== TS.IMPLICIT;
  if (ts === TS.DEFLATED) {
    const inflated = inflateSync(u8.subarray(p));
    u8 = inflated; dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); p = 0;
  }
  const { elements } = parseDataset(u8, dv, p, u8.length, explicit, 0, false);
  return { meta, elements, ts, explicit, bytes: u8 };
}

export function cleanStr(s) { return s.replace(/[\0\s]+$/g, '').replace(/^\s+/, ''); }

export function findEl(elements, tag) {
  for (let i = 0; i < elements.length; i++) if (elements[i].tag === tag) return elements[i];
  return null;
}
export function getStr(ds, tag) {
  const el = findEl(ds.elements || ds, tag);
  if (!el || !el.value) return '';
  return cleanStr(dec.decode(el.value));
}
export function getNums(ds, tag) {
  const s = getStr(ds, tag);
  if (!s) return [];
  return s.split('\\').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
}
export function getNum(ds, tag, def = NaN) { const a = getNums(ds, tag); return a.length ? a[0] : def; }
export function getUS(ds, tag, def = NaN) {
  const el = findEl(ds.elements || ds, tag);
  if (!el || !el.value || el.value.length < 2) return def;
  return el.value[0] | (el.value[1] << 8);
}
export function getUSorSS(ds, tag, signed) {
  const el = findEl(ds.elements || ds, tag);
  if (!el || !el.value || el.value.length < 2) return null;
  const v = el.value[0] | (el.value[1] << 8);
  return signed && v > 32767 ? v - 65536 : v;
}

// ---------- Escrita ----------
class Writer {
  constructor(size = 1 << 20) { this.buf = new Uint8Array(size); this.p = 0; }
  ensure(n) {
    if (this.p + n <= this.buf.length) return;
    let s = this.buf.length * 2; while (s < this.p + n) s *= 2;
    const nb = new Uint8Array(s); nb.set(this.buf.subarray(0, this.p)); this.buf = nb;
  }
  u16(v) { this.ensure(2); this.buf[this.p++] = v & 255; this.buf[this.p++] = (v >>> 8) & 255; }
  u32(v) { this.ensure(4); this.buf[this.p++] = v & 255; this.buf[this.p++] = (v >>> 8) & 255; this.buf[this.p++] = (v >>> 16) & 255; this.buf[this.p++] = (v >>> 24) & 255; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.p); this.p += b.length; }
  ascii(s) { for (let i = 0; i < s.length; i++) { this.ensure(1); this.buf[this.p++] = s.charCodeAt(i) & 255; } }
  result() { return this.buf.subarray(0, this.p); }
}

function writeElements(w, elements, explicit) {
  const sorted = elements.slice().sort((a, b) => a.tag - b.tag);
  for (const el of sorted) writeElement(w, el, explicit);
}

function writeElement(w, el, explicit) {
  const g = el.tag >>> 16, e = el.tag & 0xffff;
  if (el.items) {
    w.u16(g); w.u16(e);
    if (explicit) { w.ascii('SQ'); w.u16(0); }
    w.u32(UNDEF);
    for (const it of el.items) {
      w.u16(0xfffe); w.u16(0xe000); w.u32(UNDEF);
      writeElements(w, it, explicit);
      w.u16(0xfffe); w.u16(0xe00d); w.u32(0);
    }
    w.u16(0xfffe); w.u16(0xe0dd); w.u32(0);
    return;
  }
  let v = el.value || new Uint8Array(0);
  if (v.length & 1) { const pad = new Uint8Array(v.length + 1); pad.set(v); pad[v.length] = padByte(el.vr); v = pad; }
  w.u16(g); w.u16(e);
  if (explicit) {
    const vr = el.vr || 'UN';
    w.ascii(vr);
    if (LONG_VR.has(vr)) { w.u16(0); w.u32(v.length); }
    else {
      if (v.length > 0xffff) { // não cabe: reescreve como UN
        w.p -= 2; w.ascii('UN'); w.u16(0); w.u32(v.length);
      } else w.u16(v.length);
    }
  } else w.u32(v.length);
  w.bytes(v);
}

function padByte(vr) { return vr === 'UI' || vr === 'OB' || vr === 'UN' ? 0 : 0x20; }

export function strBytes(s, vr) {
  const b = enc.encode(s);
  if (b.length & 1) { const o = new Uint8Array(b.length + 1); o.set(b); o[b.length] = padByte(vr); return o; }
  return b;
}
export function usBytes(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }

export function setEl(elements, tag, vr, value) {
  const el = findEl(elements, tag);
  if (el) { el.vr = el.vr || vr; if (el.vr !== vr && vr) el.vr = vr; el.value = value; delete el.items; delete el.fragments; delete el.encapsulated; el.undefinedLength = false; }
  else elements.push({ tag, vr, value });
}
export function setStr(elements, tag, vr, s) { setEl(elements, tag, vr, strBytes(s, vr)); }
export function removeEl(elements, tag) {
  for (let i = elements.length - 1; i >= 0; i--) if (elements[i].tag === tag) elements.splice(i, 1);
}

export function writeDicom({ elements, explicit, sopClassUID, sopInstanceUID }) {
  const w = new Writer(1 << 19);
  for (let i = 0; i < 128; i++) w.buf[i] = 0;
  w.p = 128; w.ascii('DICM');
  const ts = explicit ? TS.EXPLICIT : TS.IMPLICIT;
  const meta = [
    { tag: T(2, 1), vr: 'OB', value: new Uint8Array([0, 1]) },
    { tag: T(2, 2), vr: 'UI', value: strBytes(sopClassUID, 'UI') },
    { tag: T(2, 3), vr: 'UI', value: strBytes(sopInstanceUID, 'UI') },
    { tag: T(2, 0x10), vr: 'UI', value: strBytes(ts, 'UI') },
    { tag: T(2, 0x12), vr: 'UI', value: strBytes(IMPL_UID, 'UI') },
    { tag: T(2, 0x13), vr: 'SH', value: strBytes('DEFACECT_1_4', 'SH') },
  ];
  const mw = new Writer(512);
  for (const el of meta) writeElement(mw, el, true);
  const mb = mw.result();
  writeElement(w, { tag: T(2, 0), vr: 'UL', value: new Uint8Array([mb.length & 255, (mb.length >>> 8) & 255, (mb.length >>> 16) & 255, mb.length >>> 24]) }, true);
  w.bytes(mb);
  writeElements(w, elements, explicit);
  return w.result().slice();
}

export const IMPL_UID = '2.25.270188459915735419093651802330165339815';

export function newUID() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return '2.25.' + n.toString();
}
