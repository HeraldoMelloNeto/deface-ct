// Web Worker do Deface CT: processa um ZIP por vez, em paralelo à interface.
import { blobSource } from './zipread.js';
import { deflateSync } from 'fflate';
import { crc32 } from './zipwrite.js';
import { scanZip, processStudy, passThroughStudy, ExamError } from './pipeline.js';

let pending = new Map(); // respostas aguardadas (código, ack)
let seq = 0;
function ask(msg) {
  return new Promise((resolve) => { const k = ++seq; pending.set(k, resolve); send({ ...msg, k }); });
}

function studySummary(st, i) {
  const f = st.first || {};
  const ch = st.chosen ? st.chosen.ev : null;
  return {
    idx: i,
    patientName: f.patientName || '', patientID: f.patientID || '', accession: f.accession || '', studyDate: f.studyDate || '', birth: f.birth || '',
    chosen: ch ? { desc: ch.desc, number: ch.number, kernel: ch.kernel, kernelValue: ch.kernelValue, contrast: ch.contrast, spacing: ch.spacing, n: ch.n } : null,
    candidates: st.candidates.map((c) => ({ desc: c.desc, ok: c.ok, reasons: c.reasons, kernel: c.kernel, contrast: c.contrast, n: c.n, spacing: c.spacing })),
    onlyContrast: !!st.onlyContrast, unsupported: st.unsupported || null,
  };
}

// agrupa arquivos em lotes (~12 MB) para reduzir mensagens; aguarda confirmação de gravação
function makeFileSink(jobId, study) {
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const files = batch; batch = []; size = 0;
    const r = await ask({ type: 'files', id: jobId, study, files, transfer: true });
    if (r && r.ok === false) throw new ExamError('write', r.quota ? 'quota' : '');
  };
  return {
    async file(name, bytes) {
      // compacta aqui (fora da interface): o processo principal só grava
      const crc = crc32(bytes);
      let data = deflateSync(bytes, { level: 3 }), method = 8;
      if (data.length >= bytes.length) { data = bytes; method = 0; }
      batch.push({ name, crc, usize: bytes.length, csize: data.length, method, data });
      size += data.length;
      if (size > 12e6) await flush();
    },
    flush,
  };
}

function transferList(obj) {
  const list = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (ArrayBuffer.isView(o)) { if (!list.includes(o.buffer)) list.push(o.buffer); return; }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(obj);
  return list;
}

function send(msg) {
  if (msg && msg.transfer) { const m = { ...msg }; delete m.transfer; self.postMessage(m, transferList(m)); }
  else self.postMessage(msg);
}

async function runJob(msg) {
  const { id, file, opts } = msg;
  const src = blobSource(file);
  let scan;
  try {
    scan = await scanZip(src, (f) => send({ type: 'progress', id, study: -1, stage: 'scan', frac: f }));
  } catch (e) {
    send({ type: 'job-error', id, code: e.code || 'unknown', detail: e.detail || e.message || '' });
    return;
  }
  send({ type: 'scan', id, studies: scan.studies.map(studySummary), skipped: scan.skipped, unsupported: scan.unsupported });
  for (let i = 0; i < scan.studies.length; i++) {
    const st = scan.studies[i];
    if (!st.chosen) { send({ type: 'study-error', id, study: i, code: 'noseries' }); continue; }
    if (st.unsupported) { send({ type: 'study-error', id, study: i, code: 'codec', detail: st.unsupported }); continue; }
    const sink = makeFileSink(id, i);
    try {
      const r = await processStudy(src, st, { anonymize: opts.anonymize }, {
        progress: (stage, frac) => send({ type: 'progress', id, study: i, stage, frac }),
        begin: () => ask({ type: 'need-code', id, study: i, accession: st.first.accession || '' }),
        file: sink.file,
      });
      await sink.flush();
      send({ type: 'done', id, study: i, report: r.report, preview: r.preview, transfer: true });
    } catch (e) {
      if (e.code === 'cancelled') continue;
      const out = { type: 'study-error', id, study: i, code: e.code || 'unknown', detail: e.detail || (e.code ? '' : (e.message || String(e))) };
      if (e.preview) { out.preview = { before: e.preview }; out.transfer = true; }
      send(out);
    }
  }
  send({ type: 'job-done', id });
}

async function runPassthrough(msg) {
  const { id, file, study, opts } = msg;
  const src = blobSource(file);
  try {
    const scan = await scanZip(src);
    const st = scan.studies[study];
    const sink = makeFileSink(id, study);
    await passThroughStudy(src, st, { anonymize: opts.anonymize, code: opts.code, folder: opts.folder }, {
      progress: (stage, frac) => send({ type: 'progress', id, study, stage, frac }),
      file: sink.file,
    });
    await sink.flush();
    send({ type: 'pass-done', id, study });
  } catch (e) {
    const known = ['rgb', 'bits', 'inconsistent'];
    send({ type: 'pass-error', id, study, code: e.code || (known.includes(e.message) ? e.message : 'unknown'), detail: e.detail || e.message || '' });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'reply') { const r = pending.get(msg.k); if (r) { pending.delete(msg.k); r(msg.data || {}); } return; }
  if (msg.type === 'job') runJob(msg).catch((e) => send({ type: 'job-error', id: msg.id, code: 'unknown', detail: String(e && e.message || e) }));
  if (msg.type === 'passthrough') runPassthrough(msg).catch((e) => send({ type: 'pass-error', id: msg.id, study: msg.study, code: 'unknown', detail: String(e) }));
};
send({ type: 'ready' });
