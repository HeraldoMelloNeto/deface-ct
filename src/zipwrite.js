// Escritor de ZIP em fluxo, com ZIP64 automático (arquivos > 4 GB ou > 65535 entradas).
import { deflateSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
export function crc32(u8) {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const te = new TextEncoder();

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  /** sink: { write(u8) => Promise|void } */
  constructor(sink, opts = {}) {
    this.sink = sink; this.offset = 0; this.entries = []; this.dt = dosDateTime();
    this.forceZip64 = !!opts.forceZip64; this.level = opts.level ?? 3;
  }
  async _w(u8) { this.offset += u8.length; await this.sink.write(u8); }
  async addFile(name, data, level = this.level) {
    const crc = crc32(data);
    let method = 8, comp = deflateSync(data, { level });
    if (comp.length >= data.length) { method = 0; comp = data; }
    await this.addRaw(name, { crc, csize: comp.length, usize: data.length, method, data: comp });
  }
  async addRaw(name, { crc, csize, usize, method, data }) {
    if (csize >= 0xffffffff || usize >= 0xffffffff) throw new Error('Entrada maior que 4 GB');
    const nb = te.encode(name);
    const h = new Uint8Array(30 + nb.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(8, method, true);
    v.setUint16(10, this.dt.time, true); v.setUint16(12, this.dt.date, true);
    v.setUint32(14, crc, true); v.setUint32(18, csize, true); v.setUint32(22, usize, true);
    v.setUint16(26, nb.length, true); v.setUint16(28, 0, true);
    h.set(nb, 30);
    const lofs = this.offset;
    await this._w(h);
    await this._w(data);
    this.entries.push({ nb, crc, csize, usize, method, lofs });
  }
  async close() {
    const cdStart = this.offset;
    const z64 = this.forceZip64 || this.entries.length >= 0xffff;
    for (const e of this.entries) {
      const needOff = this.forceZip64 || e.lofs >= 0xffffffff;
      const extra = needOff ? 12 : 0;
      const c = new Uint8Array(46 + e.nb.length + extra);
      const v = new DataView(c.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, needOff ? 45 : 20, true); v.setUint16(6, needOff ? 45 : 20, true);
      v.setUint16(8, 0x800, true); v.setUint16(10, e.method, true);
      v.setUint16(12, this.dt.time, true); v.setUint16(14, this.dt.date, true);
      v.setUint32(16, e.crc, true); v.setUint32(20, e.csize, true); v.setUint32(24, e.usize, true);
      v.setUint16(28, e.nb.length, true); v.setUint16(30, extra, true);
      v.setUint32(38, 0, true);
      v.setUint32(42, needOff ? 0xffffffff : e.lofs, true);
      c.set(e.nb, 46);
      if (needOff) {
        const q = 46 + e.nb.length;
        v.setUint16(q, 1, true); v.setUint16(q + 2, 8, true); v.setBigUint64(q + 4, BigInt(e.lofs), true);
      }
      await this._w(c);
    }
    const cdSize = this.offset - cdStart;
    const big = z64 || cdStart >= 0xffffffff || cdSize >= 0xffffffff || this.offset >= 0xffffffff;
    if (big) {
      const z = new Uint8Array(56 + 20);
      const v = new DataView(z.buffer);
      const zOff = this.offset;
      v.setUint32(0, 0x06064b50, true); v.setBigUint64(4, 44n, true); v.setUint16(12, 45, true); v.setUint16(14, 45, true);
      v.setUint32(16, 0, true); v.setUint32(20, 0, true);
      v.setBigUint64(24, BigInt(this.entries.length), true); v.setBigUint64(32, BigInt(this.entries.length), true);
      v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(cdStart), true);
      v.setUint32(56, 0x07064b50, true); v.setUint32(60, 0, true); v.setBigUint64(64, BigInt(zOff), true); v.setUint32(72, 1, true);
      await this._w(z);
    }
    const e = new Uint8Array(22);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true);
    const n = big ? 0xffff : this.entries.length;
    v.setUint16(8, n, true); v.setUint16(10, n, true);
    v.setUint32(12, big ? 0xffffffff : cdSize, true);
    v.setUint32(16, big ? 0xffffffff : cdStart, true);
    await this._w(e);
    if (this.sink.close) await this.sink.close();
    return this.offset;
  }
}
