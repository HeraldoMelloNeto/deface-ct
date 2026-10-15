// Leitor de ZIP com acesso aleatório (lê só o diretório central e cada entrada sob demanda)
// Suporta ZIP64, armazenado (0) e deflate (8).
import { inflateSync } from 'fflate';

export function blobSource(blob) {
  return {
    size: blob.size,
    async read(off, len) { return new Uint8Array(await blob.slice(off, off + len).arrayBuffer()); },
  };
}
export function bytesSource(u8) {
  return { size: u8.length, async read(off, len) { return u8.subarray(off, off + len); } };
}

const td = new TextDecoder('utf-8');
const tdLatin = new TextDecoder('latin1');

export async function listZip(src) {
  const size = src.size;
  if (size < 22) throw new Error('ZIP vazio ou inválido');
  const tailLen = Math.min(size, 65557 + 20);
  const tail = await src.read(size - tailLen, tailLen);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Arquivo não é um ZIP válido');
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('ZIP64 sem localizador');
    const z64off = Number(dv.getBigUint64(loc + 8, true));
    const z = await src.read(z64off, 56);
    const zd = new DataView(z.buffer, z.byteOffset, z.byteLength);
    if (zd.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 inválido');
    count = Number(zd.getBigUint64(32, true));
    cdSize = Number(zd.getBigUint64(40, true));
    cdOff = Number(zd.getBigUint64(48, true));
  }
  if (cdOff + cdSize > size) throw new Error('ZIP truncado');
  const cd = await src.read(cdOff, cdSize);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (cv.getUint32(p, true) !== 0x02014b50) throw new Error('Diretório central inválido');
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    let csize = cv.getUint32(p + 20, true);
    let usize = cv.getUint32(p + 24, true);
    const nlen = cv.getUint16(p + 28, true), xlen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
    let lofs = cv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? td : tdLatin).decode(nameBytes);
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cv.getUint16(x, true), sz = cv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (lofs === 0xffffffff) { lofs = Number(cv.getBigUint64(q, true)); q += 8; }
      }
      x += 4 + sz;
    }
    p = xend + clen;
    if (name.endsWith('/')) continue;
    entries.push({ name, method, crc, csize, usize, lofs, encrypted: !!(flags & 1) });
  }
  return entries;
}

export async function readZipEntry(src, e, raw = false) {
  if (e.encrypted) throw new Error('ZIP protegido por senha não é suportado');
  const h = await src.read(e.lofs, 30);
  const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('Entrada ZIP inválida');
  const start = e.lofs + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const data = await src.read(start, e.csize);
  if (raw) return data;
  if (e.method === 0) return data;
  if (e.method === 8) return inflateSync(data, { out: new Uint8Array(e.usize) });
  throw new Error('Método de compressão ZIP não suportado (' + e.method + ')');
}
