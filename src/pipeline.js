// Processamento de um ZIP: leitura de cabeçalhos, escolha da série, desidentificação e gravação.
import { parseDicom, newUID } from './dicom.js';
import { listZip, readZipEntry } from './zipread.js';
import { headerInfo, chooseSeries } from './series.js';
import { SUPPORTED_TS, tsName } from './codecs.js';
import { loadVolume, buildSlice } from './volume.js';
import { deface } from './deface.js';
import { makePreview, qcSlices } from './preview.js';

const LOSSY = new Set(['1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);

export class ExamError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; }
}

/** Varre o ZIP e devolve os estudos com a série escolhida. */
export async function scanZip(src, onProgress) {
  let entries;
  try { entries = await listZip(src); } catch (e) { throw new ExamError('zip', e.message); }
  const cand = entries.filter((e) => !/(^|\/)(DICOMDIR|__MACOSX\/.*|\.DS_Store|Thumbs\.db)$/i.test(e.name) && !/\.(txt|pdf|jpe?g|png|xml|html?|exe|ini|json|csv|bat|inf)$/i.test(e.name) && !/__MACOSX\//.test(e.name));
  if (entries.some((e) => e.encrypted)) throw new ExamError('encrypted');
  const headers = [];
  let skipped = 0, unsupported = new Set();
  for (let i = 0; i < cand.length; i++) {
    const e = cand[i];
    if (e.usize < 132) { skipped++; continue; }
    let ds;
    try {
      const bytes = await readZipEntry(src, e);
      ds = parseDicom(bytes);
    } catch (err) { skipped++; continue; }
    const info = headerInfo(ds);
    if (!info.hasPixels) { skipped++; continue; }
    if (!SUPPORTED_TS.has(info.ts)) unsupported.add(info.ts);
    headers.push({ entry: e, info });
    if (onProgress && (i % 16 === 0 || i === cand.length - 1)) onProgress((i + 1) / cand.length);
  }
  if (!headers.length) throw new ExamError('nodicom');
  const studies = chooseSeries(headers);
  for (const s of studies) {
    if (s.chosen && !SUPPORTED_TS.has(s.chosen.ev.ts)) {
      s.unsupported = tsName(s.chosen.ev.ts);
    }
  }
  return { studies, skipped, total: entries.length, unsupported: [...unsupported].map(tsName) };
}

/**
 * Processa um estudo já escolhido.
 * io: { progress(stage, frac), file(name, bytes) => Promise, preview(obj) }
 */
export async function processStudy(src, study, opts, io) {
  if (!study.chosen) throw new ExamError('noseries');
  if (study.unsupported) throw new ExamError('codec', study.unsupported);
  const t0 = Date.now();
  let V;
  try {
    V = await loadVolume(study.chosen, (e) => readZipEntry(src, e), (f) => io.progress('decode', f));
  } catch (e) {
    const m = e && e.message;
    if (m === 'rgb' || m === 'bits' || m === 'inconsistent') throw new ExamError(m);
    throw new ExamError('decode', m);
  }
  io.progress('analyze', 0);
  const before = makePreview(V);
  let report;
  const changedMask = V.simple ? null : new Uint8Array(V.vol.length);
  let qcBefore = null;
  try {
    report = deface(V, { changedMask, beforeWrite: (L0) => { qcBefore = qcSlices(V, L0.mx, L0.eyeZ); } });
  } catch (e) {
    const code = e && e.message;
    if (['nohead', 'nonose', 'noeyes', 'noface'].includes(code)) {
      // sem face identificável: não altera, mas oferece saída somente após aprovação
      const err = new ExamError(code);
      err.preview = before;
      throw err;
    }
    throw new ExamError('analyze', code);
  }
  io.progress('write', 0);
  const after = makePreview(V);
  const L = report.landmarks;
  const qcAfter = qcSlices(V, L.mx, L.eyeZ);
  // o nome de saída só é reservado depois que a face foi encontrada (sem lacunas na numeração)
  const named = io.begin ? await io.begin() : { code: opts.code, folder: opts.folder };
  if (!named || named.skip) throw new ExamError('cancelled');
  const ctx = {
    anonymize: !!opts.anonymize, code: named.code, changedMask, lossySource: LOSSY.has(study.chosen.ev.ts),
    seriesUID: newUID(), studyUID: newUID(), forUID: newUID(),
  };
  const folder = named.folder;
  for (let z = 0; z < V.nz; z++) {
    const bytes = buildSlice(V, z, ctx);
    await io.file(`${folder}/IM${String(z + 1).padStart(4, '0')}.dcm`, bytes);
    if (z % 8 === 0 || z === V.nz - 1) io.progress('write', (z + 1) / V.nz);
  }
  const ev = study.chosen.ev;
  return {
    report: {
      landmarks: L, changed: report.changed, sealed: report.sealed, notes: report.notes,
      slices: V.nz, dims: [V.nx, V.ny, V.nz], spacing: [V.sx, V.sy, V.sz],
      series: { desc: ev.desc, number: ev.number, kernel: ev.kernel, kernelValue: ev.kernelValue, contrast: ev.contrast, spacing: ev.spacing, n: ev.n, ts: tsName(ev.ts) },
      onlyContrast: study.onlyContrast, ms: Date.now() - t0,
    },
    preview: { before, after, qcBefore, qcAfter, spacing: [V.sx, V.sy, V.sz] },
  };
}

/** Grava a série original sem alteração da face (só usada quando o usuário aprova explicitamente) */
export async function passThroughStudy(src, study, opts, io) {
  const V = await loadVolume(study.chosen, (e) => readZipEntry(src, e), (f) => io.progress('decode', f));
  const ctx = { passthrough: true, lossySource: LOSSY.has(study.chosen.ev.ts), anonymize: !!opts.anonymize, code: opts.code, changedMask: null, seriesUID: newUID(), studyUID: newUID(), forUID: newUID() };
  for (let z = 0; z < V.nz; z++) {
    const bytes = buildSlice(V, z, ctx);
    await io.file(`${opts.folder}/IM${String(z + 1).padStart(4, '0')}.dcm`, bytes);
    if (z % 8 === 0 || z === V.nz - 1) io.progress('write', (z + 1) / V.nz);
  }
  return { slices: V.nz };
}
