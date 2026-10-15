// Teste do motor em Node: node test/run.cjs entrada.zip pasta_saida [--anon]
const fs = require('fs');
const path = require('path');
const E = require('../dist/engine.node.cjs');

async function main() {
  const [inp, outDir] = process.argv.slice(2);
  const anon = process.argv.includes('--anon');
  fs.mkdirSync(outDir, { recursive: true });
  const buf = new Uint8Array(fs.readFileSync(inp));
  const src = E.bytesSource(buf);
  const t0 = Date.now();
  const scan = await E.scanZip(src);
  const summary = { input: path.basename(inp), studies: [] };
  for (const [i, st] of scan.studies.entries()) {
    const s = { candidates: st.candidates.map((c) => ({ desc: c.desc, ok: c.ok, reasons: c.reasons, kernel: c.kernel, kv: c.kernelValue, contrast: c.contrast, n: c.n })), chosen: st.chosen && st.chosen.ev.desc, onlyContrast: st.onlyContrast };
    const code = 'DEFACE_' + String(i + 1).padStart(3, '0');
    const chunks = [];
    const zipChunks = [];
    const zw = new E.ZipWriter({ write: (u8) => { zipChunks.push(u8.slice()); } });
    try {
      const r = await E.processStudy(src, st, { anonymize: anon, code, folder: code }, {
        progress: () => {},
        file: async (name, bytes) => { await zw.addFile(name, bytes); },
      });
      await zw.close();
      fs.writeFileSync(path.join(outDir, code + '.zip'), Buffer.concat(zipChunks.map((c) => Buffer.from(c))));
      s.report = r.report;
      const pv = r.preview;
      for (const k of ['before', 'after']) fs.writeFileSync(path.join(outDir, `${code}_${k}.u8`), Buffer.from(pv[k].data));
      fs.writeFileSync(path.join(outDir, `${code}_prev.json`), JSON.stringify({ before: { ...pv.before, data: undefined }, after: { ...pv.after, data: undefined } }));
      for (const k of ['qcBefore', 'qcAfter']) if (pv[k]) {
        fs.writeFileSync(path.join(outDir, `${code}_${k}_sag.u8`), Buffer.from(pv[k].sag.data));
        fs.writeFileSync(path.join(outDir, `${code}_${k}_ax.u8`), Buffer.from(pv[k].ax.data));
        s[k] = { sag: [pv[k].sag.w, pv[k].sag.h], ax: [pv[k].ax.w, pv[k].ax.h] };
      }
    } catch (e) {
      s.error = e.code || e.message; s.detail = e.detail; if (!e.code) s.stack = e.stack;
    }
    summary.studies.push(s);
  }
  summary.ms = Date.now() - t0;
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
