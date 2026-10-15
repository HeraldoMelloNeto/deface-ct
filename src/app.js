// Deface CT v1.4 — interface (fila de até 100 exames, PT/EN, tema claro/escuro)
import { I18N } from './i18n.js';
import { ZipWriter } from './zipwrite.js';
import { listZip, readZipEntry, blobSource } from './zipread.js';

const VERSION = '1.4';
const MAX_BATCH = 100;
const API = '/.netlify/functions/';

// ---------------- utilidades ----------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const store = {
  get(k, d) { try { const v = localStorage.getItem('deface.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('deface.' + k, v); } catch (e) { /* armazenamento indisponível */ } },
  del(k) { try { localStorage.removeItem('deface.' + k); } catch (e) { /* idem */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
let lang = store.get('lang', (navigator.language || 'pt').toLowerCase().startsWith('pt') ? 'pt' : 'en');
if (!I18N[lang]) lang = 'pt';
function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) ?? I18N.pt[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}
function fmtBytes(n) {
  if (!(n >= 0)) return t('sizeUnknown');
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}
function fmtTime(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + ' min' + (r ? ' ' + r + ' s' : '');
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function toast(msg) {
  const d = document.createElement('div'); d.className = 't'; d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), 5200);
}
function stamp() {
  const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------- idioma e tema ----------------
function applyLang() {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  document.title = t('title');
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const b of $$('#langSeg button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  updateChromeBanner(); updateDestInfo(); renderAccess(); renderAllRows(); updateOverall(); updateDownloadCard(); refreshViewerSelect(); updateLandmarkChips();
  $('#parallelInfo').textContent = t('parallel', { n: POOL });
}
let themePref = store.get('theme', 'auto');
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const dark = themePref === 'dark' || (themePref === 'auto' && mq && mq.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-pref', themePref);
  for (const b of $$('#themeSeg button')) b.setAttribute('aria-pressed', String(b.dataset.themeBtn === themePref));
  requestFullRender(); drawQC();
}
if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (themePref === 'auto') applyTheme(); });

// ---------------- Chrome ----------------
function isChrome() {
  const b = navigator.userAgentData && navigator.userAgentData.brands;
  if (b && b.length) return b.some((x) => x.brand === 'Google Chrome');
  return /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\/|Brave|SamsungBrowser/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor || '');
}
function updateChromeBanner() {
  const ok = isChrome();
  $('#chromeBanner').classList.toggle('warn', !ok);
  $('#chromeTitle').textContent = ok ? t('chromeTitle') : t('chromeWarn');
  $('#chromeText').textContent = ok ? t('chromeText') : '';
}

// ---------------- workers ----------------
const workerCode = document.getElementById('wk-engine') ? document.getElementById('wk-engine').textContent : '';
const renderCode = document.getElementById('wk-render') ? document.getElementById('wk-render').textContent : '';
const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
let engineUrl = null;
function makeEngineWorker() {
  if (!engineUrl) engineUrl = blobUrl(workerCode);
  return new Worker(engineUrl);
}
const mem = navigator.deviceMemory || 4;
const cores = navigator.hardwareConcurrency || 2;
const POOL = mem >= 8 && cores >= 8 ? 2 : 1;

// ---------------- armazenamento local (OPFS) ----------------
let opfsRoot = null;
const TAB = 'deface-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function opfs() {
  if (opfsRoot) return opfsRoot;
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('opfs');
  const root = await navigator.storage.getDirectory();
  opfsRoot = await root.getDirectoryHandle(TAB, { create: true });
  return opfsRoot;
}
async function opfsDir(name) { return (await opfs()).getDirectoryHandle(name, { create: true }); }
// cada aba usa sua própria pasta; ao abrir, remove apenas pastas de abas que já fecharam
async function opfsInit() {
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(TAB, () => new Promise(() => {})).catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
    }
    const root = await navigator.storage.getDirectory();
    let held = null;
    if (navigator.locks && navigator.locks.query) {
      const q = await navigator.locks.query();
      held = new Set([...(q.held || []), ...(q.pending || [])].map((l) => l.name));
    }
    const names = [];
    for await (const [n] of root.entries()) names.push(n);
    for (const n of names) {
      if (n === TAB) continue;
      const legacy = n === 'deface-out' || n === 'deface-prev' || n === 'deface-tmp';
      if (legacy || (n.startsWith('deface-') && held && !held.has(n))) { try { await root.removeEntry(n, { recursive: true }); } catch (e) { /* em uso */ } }
    }
  } catch (e) { /* sem OPFS */ }
}
async function opfsClear() {
  try {
    const r = await opfs();
    for (const n of ['out', 'prev', 'tmp']) { try { await r.removeEntry(n, { recursive: true }); } catch (e) { /* inexistente */ } }
  } catch (e) { /* sem OPFS */ }
}

class BufferedSink {
  constructor(writable) { this.w = writable; this.buf = []; this.size = 0; this.total = 0; }
  async write(u8) {
    this.buf.push(u8); this.size += u8.length; this.total += u8.length;
    if (this.size >= 8 * 1024 * 1024) await this.flush();
  }
  async flush() {
    if (!this.size) return;
    const all = new Uint8Array(this.size); let p = 0;
    for (const b of this.buf) { all.set(b, p); p += b.length; }
    this.buf = []; this.size = 0;
    await this.w.write(all);
  }
  async close() { await this.flush(); await this.w.close(); }
  async abort() { try { await this.w.abort(); } catch (e) { /* já fechado */ } }
}

// ---------------- estado ----------------
const state = {
  access: 'checking', email: '', session: '', sentTo: '',
  destDir: null, destName: '',
  jobs: [], running: false, paused: false, seq: 0, usedNames: new Set(),
  times: [], startedAt: 0,
};
let jobId = 0;
const workers = []; // {w, busy, job}

function settings() {
  return {
    naming: (document.querySelector('input[name=naming]:checked') || {}).value || 'code',
    anonymize: $('#optAnon').checked,
    csv: $('#optCsv').checked,
  };
}

// ---------------- acesso (e-mail) ----------------
async function api(name, opts) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API + name, { ...opts, signal: ctl.signal, cache: 'no-store', headers: { 'content-type': 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body };
  } finally { clearTimeout(to); }
}
function previewHost() {
  const h = location.hostname || '';
  let framed = false;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (framed) return true; // dentro de um quadro (pré-visualização): downloads e escolha de pasta bloqueados
  return location.protocol === 'file:' || /(^|\.)(claude\.ai|claudeusercontent\.com|anthropic\.com|claude\.site)$/i.test(h);
}
async function initAccess() {
  state.access = 'checking'; renderAccess();
  if (previewHost()) { state.access = 'preview'; renderAccess(); return; }
  // o site publicado pelo repositório envia o cabeçalho X-Deface-Functions (netlify.toml);
  // sem ele (ex.: Netlify Drop só com o HTML) não há funções e nada é consultado
  let hasFunctions = false;
  try {
    const r = await fetch(location.pathname || '/', { method: 'HEAD', cache: 'no-store' });
    hasFunctions = r.headers.get('x-deface-functions') === '1';
  } catch (e) { hasFunctions = false; }
  if (!hasFunctions) { state.access = 'preview'; renderAccess(); return; }
  let health = null;
  try { health = await api('send-code', { method: 'GET' }); } catch (e) { health = null; }
  if (!health || health.status !== 200 || !health.body || health.body.service !== 'deface-ct') {
    state.access = 'preview'; renderAccess(); return;
  }
  if (!health.body.configured) { state.access = 'unconfigured'; renderAccess(); return; }
  const sess = store.get('session', '');
  if (sess) {
    try {
      const r = await api('verify-code', { method: 'POST', body: JSON.stringify({ session: sess }) });
      if (r.body && r.body.ok) { state.access = 'verified'; state.email = r.body.email; state.session = sess; renderAccess(); return; }
    } catch (e) { /* segue para novo pedido */ }
    store.del('session');
  }
  state.access = 'need'; renderAccess();
}
function accessOk() { return state.access === 'verified' || state.access === 'preview' || state.access === 'unconfigured'; }
function showMsg(el, kind, text) { el.className = 'msg ' + kind; el.textContent = text; el.classList.remove('hidden'); }
function hideMsg(el) { el.classList.add('hidden'); el.textContent = ''; }
function renderAccess() {
  const a = state.access;
  $('#accChecking').classList.toggle('hidden', a !== 'checking');
  $('#accNeed').classList.toggle('hidden', a !== 'need');
  $('#accCode').classList.toggle('hidden', a !== 'code');
  $('#accVerified').classList.toggle('hidden', a !== 'verified');
  $('#accPreview').classList.toggle('hidden', a !== 'preview');
  $('#accUnconf').classList.toggle('hidden', a !== 'unconfigured');
  $('#sentTo').textContent = state.sentTo;
  $('#verEmail').textContent = state.email;
  $('#lockedHint').classList.toggle('hidden', accessOk() || a === 'checking');
  $('#drop').classList.toggle('locked', !accessOk());
  updateButtons();
}
let resendTimer = null, resendLeft = 0;
function startResendCooldown() {
  resendLeft = 30;
  const b = $('#btnResend');
  const tick = () => {
    if (resendLeft <= 0) { b.disabled = false; b.textContent = t('resend'); clearInterval(resendTimer); resendTimer = null; return; }
    b.disabled = true; b.textContent = t('resendIn', { s: resendLeft }); resendLeft--;
  };
  if (resendTimer) clearInterval(resendTimer);
  tick(); resendTimer = setInterval(tick, 1000);
}
async function sendCode(email) {
  const m1 = $('#accMsg1'), m2 = $('#accMsg2');
  hideMsg(m1); hideMsg(m2);
  const btn = state.access === 'code' ? $('#btnResend') : $('#btnSend');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = t('sending');
  try {
    const r = await api('send-code', { method: 'POST', body: JSON.stringify({ email, consent: true, lang }) });
    if (r.body && r.body.ok) {
      state.sentTo = email; state.access = 'code'; renderAccess(); startResendCooldown();
      $('#code').value = ''; setTimeout(() => $('#code').focus(), 30);
      return;
    }
    const err = r.body && r.body.error;
    const map = { invalid_email: 'errInvalidEmail', consent: 'errConsent', rate: 'errRate', send_failed: 'errSend', not_configured: 'unconfigured' };
    showMsg(state.access === 'code' ? m2 : m1, 'err', t(map[err] || 'errSend'));
  } catch (e) {
    showMsg(state.access === 'code' ? m2 : m1, 'err', t('errNetwork'));
  } finally {
    btn.disabled = false; btn.textContent = label;
    if (state.access === 'code' && resendLeft > 0) $('#btnResend').disabled = true;
  }
}
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
$('#btnSend').addEventListener('click', () => {
  const email = $('#email').value.trim().toLowerCase();
  const m1 = $('#accMsg1');
  if (!EMAIL_RE.test(email) || email.length > 254) { showMsg(m1, 'err', t('errInvalidEmail')); $('#email').focus(); return; }
  if (!$('#consent').checked) { showMsg(m1, 'err', t('errConsent')); return; }
  sendCode(email);
});
$('#email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSend').click(); });
$('#btnResend').addEventListener('click', () => sendCode(state.sentTo));
$('#btnChange').addEventListener('click', () => { state.access = 'need'; hideMsg($('#accMsg2')); renderAccess(); $('#email').focus(); });
$('#code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) $('#btnVerify').click(); });
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnVerify').click(); });
let verifying = false;
$('#btnVerify').addEventListener('click', async () => {
  if (verifying) return;
  const code = $('#code').value.replace(/\D/g, '');
  const m2 = $('#accMsg2');
  if (code.length !== 6) { showMsg(m2, 'err', t('errCodeFormat')); return; }
  verifying = true;
  const b = $('#btnVerify'); b.disabled = true; b.textContent = t('verifying'); hideMsg(m2);
  try {
    const r = await api('verify-code', { method: 'POST', body: JSON.stringify({ email: state.sentTo, code }) });
    if (r.body && r.body.ok) {
      state.access = 'verified'; state.email = r.body.email; state.session = r.body.session;
      store.set('session', r.body.session);
      renderAccess(); toast(t('verified') + ': ' + state.email);
    } else {
      const err = r.body && r.body.error;
      if (err === 'invalid') showMsg(m2, 'err', t('errCode', { n: r.body.remaining ?? 0 }));
      else if (err === 'too_many') showMsg(m2, 'err', t('errTooMany'));
      else if (err === 'expired') showMsg(m2, 'err', t('errExpired'));
      else showMsg(m2, 'err', t('errNetwork'));
    }
  } catch (e) { showMsg(m2, 'err', t('errNetwork')); }
  finally { verifying = false; b.disabled = false; b.textContent = t('verify'); }
});
$('#btnLogout').addEventListener('click', () => { store.del('session'); state.session = ''; state.email = ''; state.access = 'need'; renderAccess(); });

// ---------------- destino ----------------
const fsaDir = typeof window.showDirectoryPicker === 'function';
function updateDestInfo() {
  const info = $('#destInfo');
  const btnLabel = $('#btnDest span');
  if (!fsaDir || previewHost()) { info.textContent = t('destUnsupported'); $('#btnDest').disabled = true; return; }
  if (state.destDir) {
    info.innerHTML = esc(t('destChosen')) + ' <span class="path">' + esc(state.destName) + '</span>';
    btnLabel.textContent = t('destChange');
  } else { info.textContent = t('destNone'); btnLabel.textContent = t('destPick'); }
}
$('#btnDest').addEventListener('click', async () => {
  if (state.running) { toast(t('busy')); return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'deface-ct-out', mode: 'readwrite', startIn: 'downloads' });
    if (h.requestPermission) {
      const p = await h.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') { toast(t('destDenied')); return; }
    }
    state.destDir = h; state.destName = h.name;
    updateDestInfo(); updateDownloadCard(); renderAllRows(); checkStorage();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (e && (e.name === 'SecurityError' || e.name === 'NotAllowedError')) { toast(t('destUnsupported')); return; }
    toast(t('destDenied'));
  }
});

// ---------------- fila ----------------
function addFiles(list) {
  if (!accessOk()) { toast(t('lockedHint')); return; }
  const files = Array.from(list || []);
  const zips = files.filter((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed');
  const notZip = files.length - zips.length;
  const active = state.jobs.filter((j) => j.state !== 'cancelled').length;
  const room = Math.max(0, MAX_BATCH - active);
  const take = zips.slice(0, room);
  for (const f of take) state.jobs.push({ id: ++jobId, file: f, name: f.name, size: f.size, state: 'queued', stage: '', frac: 0, studies: [], error: null });
  if (notZip) toast(t('notZip', { n: notZip }));
  if (zips.length > take.length) toast(t('limitNote', { n: take.length }));
  else if (take.length) toast(t('toastAdded', { n: take.length }));
  renderAllRows(); updateOverall(); updateButtons(); checkStorage();
}
const drop = $('#drop');
drop.addEventListener('click', (e) => { if (e.target && e.target.id === 'fileInput') return; if (accessOk()) $('#fileInput').click(); else toast(t('lockedHint')); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { addFiles(e.dataTransfer && e.dataTransfer.files); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function updateButtons() {
  const queued = state.jobs.some((j) => j.state === 'queued');
  const running = state.jobs.some((j) => j.state === 'running');
  $('#btnStart').disabled = !accessOk() || !queued || (state.running && !state.paused);
  $('#btnPause').disabled = !state.running;
  $('#btnPause').textContent = state.paused ? t('resume') : t('pause');
  $('#btnCancel').disabled = !(running || (state.running && queued));
  $('#btnClear').disabled = state.jobs.length === 0 || running;
  const retryable = state.jobs.some(canRetry);
  $('#btnRetry').classList.toggle('hidden', !retryable);
  $('#btnRetry').disabled = running;
  for (const el of $$('input[name=naming], #optAnon, #optCsv')) el.disabled = running;
}
async function checkStorage() {
  const box = $('#storageMsg');
  if (state.destDir || !navigator.storage || !navigator.storage.estimate) { box.classList.add('hidden'); return; }
  try {
    const est = await navigator.storage.estimate();
    const free = Math.max(0, (est.quota || 0) - (est.usage || 0));
    const need = state.jobs.filter((j) => j.state === 'queued').reduce((a, j) => a + j.size * 1.15 + 2.5e6, 0);
    if (need > free * 0.9) { box.textContent = t('storageLow', { free: fmtBytes(free), need: fmtBytes(need) }); box.classList.remove('hidden'); }
    else box.classList.add('hidden');
  } catch (e) { box.classList.add('hidden'); }
}
$('#btnStart').addEventListener('click', () => {
  if (!accessOk()) return;
  checkStorage();
  state.running = true; state.paused = false;
  if (!state.startedAt) state.startedAt = Date.now();
  updateButtons(); pump();
});
const PERMANENT = ['zip', 'encrypted', 'nodicom', 'noseries', 'codec', 'rgb', 'bits', 'inconsistent'];
function canRetry(j) {
  if (j.state === 'error') return !PERMANENT.includes(j.error);
  return j.state === 'done' && j.studies.length > 0 && j.studies.every((x) => x.status === 'error' && !PERMANENT.includes(x.error));
}
$('#btnRetry').addEventListener('click', () => {
  for (const j of state.jobs) {
    if (canRetry(j)) {
      for (const x of j.studies) { if (x.outHandle) removeOut(x); if (x.code) state.usedNames.delete(x.code.toLowerCase()); }
      j.state = 'queued'; j.studies = []; j.error = null; j.detail = ''; j.stage = ''; j.frac = 0;
    }
  }
  renderAllRows(); updateOverall(); updateButtons();
});
$('#btnPause').addEventListener('click', () => {
  state.paused = !state.paused;
  if (!state.paused) pump();
  updateButtons();
});
function askConfirm(text) {
  return new Promise((resolve) => {
    const d = $('#dlgConfirm');
    $('#cfText').textContent = text; $('#cfYes').textContent = t('yes'); $('#cfNo').textContent = t('no');
    const done = (v) => { $('#cfYes').onclick = null; $('#cfNo').onclick = null; d.oncancel = null; d.close(); resolve(v); };
    $('#cfYes').onclick = () => done(true); $('#cfNo').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    d.showModal();
  });
}
$('#btnCancel').addEventListener('click', async () => {
  if (!(await askConfirm(t('confirmCancel')))) return;
  await cancelAll();
});
$('#btnClear').addEventListener('click', async () => {
  if (!(await askConfirm(t('confirmClear')))) return;
  await cancelAll();
  state.jobs = []; state.seq = 0; state.usedNames = new Set(); state.times = []; state.startedAt = 0;
  if (viewer.current) { broadcast({ type: 'drop', key: viewer.current + ':before' }); broadcast({ type: 'drop', key: viewer.current + ':after' }); }
  viewer.current = null; viewer.study = null; qcData = null; previewCache.clear(); memOnly.clear();
  await opfsClear();
  renderAllRows(); updateOverall(); updateButtons(); updateDownloadCard(); refreshViewerSelect();
});

async function cancelAll() {
  for (const w of workers) { try { w.w.terminate(); } catch (e) { /* já encerrado */ } }
  for (const w of workers) if (w.job) await abortJobOutputs(w.job);
  workers.length = 0;
  for (const j of state.jobs) if (j.state === 'running' || j.state === 'queued') { j.state = 'cancelled'; for (const s of j.studies) if (!['done', 'alert', 'error', 'pass'].includes(s.status)) s.status = 'cancelled'; }
  state.running = false; state.paused = false;
  renderAllRows(); updateOverall(); updateButtons(); updateDownloadCard();
}
async function abortJobOutputs(job) {
  for (const s of job.studies) {
    if (s.sink) { await s.sink.abort(); s.sink = null; await removeOut(s); }
  }
}
async function removeOut(s) {
  try { if (s.outDir && s.outName) await s.outDir.removeEntry(s.outName); } catch (e) { /* inexistente */ }
  s.outHandle = null;
}

function pump() {
  if (state.running && !state.jobs.some((j) => j.state === 'queued' || j.state === 'running')) { state.running = false; state.paused = false; }
  if (!state.running || state.paused) { updateButtons(); return; }
  while (true) {
    const next = state.jobs.find((j) => j.state === 'queued');
    if (!next) break;
    let slot = workers.find((w) => !w.busy);
    if (!slot && workers.length < POOL) {
      try { slot = { w: makeEngineWorker(), busy: false, job: null }; } catch (e) { toast(t('err_unknown') + ' (worker)'); state.running = false; break; }
      // mensagens tratadas em ordem (um tratamento assíncrono termina antes do próximo começar)
      slot.chain = Promise.resolve();
      slot.w.onmessage = (ev) => { slot.chain = slot.chain.then(() => onWorkerMsg(slot, ev.data)).catch((err) => console.warn(err)); };
      slot.w.onerror = (ev) => { ev.preventDefault(); onWorkerCrash(slot, ev.message || 'worker'); };
      workers.push(slot);
    }
    if (!slot) break;
    slot.busy = true; slot.job = next;
    next.state = 'running'; next.stage = 'scan'; next.frac = 0; next.t0 = Date.now();
    slot.w.postMessage({ type: 'job', id: next.id, file: next.file, opts: { anonymize: settings().anonymize } });
    renderJob(next);
  }
  if (!state.jobs.some((j) => j.state === 'queued' || j.state === 'running')) { state.running = false; state.paused = false; }
  updateButtons(); updateOverall();
}

async function onWorkerCrash(slot, msg) {
  const job = slot.job;
  try { slot.w.terminate(); } catch (e) { /* ok */ }
  const i = workers.indexOf(slot); if (i >= 0) workers.splice(i, 1);
  if (job) {
    await abortJobOutputs(job);
    job.state = 'error'; job.error = /memory|alloc|Array buffer/i.test(msg) ? 'memory' : 'unknown'; job.detail = msg;
    for (const s of job.studies) if (!['done', 'alert', 'error', 'pass'].includes(s.status)) { s.status = 'error'; s.error = job.error; }
    renderJob(job);
  }
  pump();
}

const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || e)));
function onQuota() {
  if (!state.paused && state.running) { state.paused = true; updateButtons(); }
  toast(t('err_quota'));
}
function sanitizeName(s) { return String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 48); }
let nameChain = Promise.resolve();
function uniqueName(dir, base) {
  // serializa as reservas para que dois exames nunca recebam o mesmo nome
  const run = nameChain.then(async () => {
    let name = base, k = 1;
    for (;;) {
      let exists = state.usedNames.has(name.toLowerCase());
      if (!exists && dir) { try { await dir.getFileHandle(name + '.zip'); exists = true; } catch (e) { exists = false; } }
      if (!exists) break;
      k++; name = base + '_' + k;
    }
    state.usedNames.add(name.toLowerCase());
    return name;
  });
  nameChain = run.catch(() => {});
  return run;
}

async function onWorkerMsg(slot, m) {
  const job = state.jobs.find((j) => j.id === m.id);
  const reply = (data) => slot.w.postMessage({ type: 'reply', k: m.k, data });
  if (!job || job.state === 'cancelled') { if (m.k) reply({ skip: true }); return; }
  switch (m.type) {
    case 'progress': {
      job.stage = m.stage; job.frac = m.frac;
      if (m.study >= 0 && job.studies[m.study]) { const s = job.studies[m.study]; s.stage = m.stage; s.frac = m.frac; }
      throttleRender(job);
      break;
    }
    case 'scan': {
      job.studies = m.studies.map((s) => ({ ...s, summary: s, status: 'queued', stage: '', frac: 0 }));
      job.skipped = m.skipped;
      renderJob(job);
      break;
    }
    case 'need-code': {
      const s = job.studies[m.study];
      const st = settings();
      let base;
      if (st.naming === 'acc' && sanitizeName(m.accession)) base = sanitizeName(m.accession);
      else { state.seq++; base = 'DEFACE_' + String(state.seq).padStart(3, '0'); }
      try {
        const dir = state.destDir || await opfsDir('out');
        const name = await uniqueName(dir, base);
        const fh = await dir.getFileHandle(name + '.zip', { create: true });
        const writable = await fh.createWritable();
        s.sink = new BufferedSink(writable);
        s.zw = new ZipWriter(s.sink);
        s.outDir = dir; s.outName = name + '.zip'; s.outHandle = fh; s.code = name; s.folder = name; s.inDest = !!state.destDir;
        s.status = 'running';
        renderJob(job);
        reply({ code: name, folder: name });
      } catch (e) {
        s.status = 'error'; s.error = isQuota(e) ? 'quota' : 'write'; s.detail = String(e && e.message || e);
        if (isQuota(e)) onQuota();
        renderJob(job);
        reply({ skip: true });
      }
      break;
    }
    case 'files': {
      const s = job.studies[m.study];
      try {
        for (const f of m.files) await s.zw.addRaw(f.name, f);
        reply({ ok: true });
      } catch (e) {
        s.writeError = String(e && e.message || e); s.quota = isQuota(e);
        reply({ ok: false, quota: s.quota });
      }
      break;
    }
    case 'done': {
      const s = job.studies[m.study];
      try {
        if (s.writeError) throw new Error(s.writeError);
        s.outSize = await s.zw.close(); s.sink = null; s.zw = null;
        s.report = m.report; s.status = 'done';
        s.previewKey = job.id + '_' + m.study;
        await savePreview(s.previewKey, m.preview);
        s.hasAfter = true;
        state.times.push(m.report.ms);
        makeThumb(s, m.preview.after);
      } catch (e) {
        let q = s.quota || isQuota(e);
        if (!q && !state.destDir) { try { const est = await navigator.storage.estimate(); q = est.quota > 0 && est.usage / est.quota > 0.95; } catch (e2) { /* sem estimativa */ } }
        s.status = 'error'; s.error = q ? 'quota' : 'write'; s.detail = String(e && e.message || e);
        if (s.sink) { await s.sink.abort(); s.sink = null; } await removeOut(s);
        if (s.code) state.usedNames.delete(s.code.toLowerCase());
        if (q) onQuota();
      }
      renderJob(job); updateDownloadCard(); refreshViewerSelect();
      break;
    }
    case 'study-error': {
      const s = job.studies[m.study];
      if (s.sink) { await s.sink.abort(); s.sink = null; s.zw = null; await removeOut(s); }
      if (s.code) state.usedNames.delete(s.code.toLowerCase());
      s.code = null;
      const faceCodes = ['nohead', 'nonose', 'noeyes', 'noface'];
      s.status = faceCodes.includes(m.code) ? 'alert' : 'error';
      s.error = m.code === 'write' && (m.detail === 'quota' || s.quota) ? 'quota' : m.code; s.detail = m.detail || '';
      if (s.error === 'quota') onQuota();
      if (m.preview && m.preview.before) { s.previewKey = job.id + '_' + m.study; await savePreview(s.previewKey, m.preview); s.hasAfter = false; }
      renderJob(job); updateDownloadCard(); refreshViewerSelect();
      break;
    }
    case 'job-error': {
      job.state = 'error'; job.error = m.code; job.detail = m.detail;
      break;
    }
    case 'job-done': {
      if (job.state !== 'error') job.state = 'done';
      break;
    }
    case 'pass-done': case 'pass-error': {
      const cb = passWaiters.get(job.id + '_' + m.study);
      if (cb) { passWaiters.delete(job.id + '_' + m.study); cb(m); }
      break;
    }
    default: break;
  }
  if (m.type === 'job-error' || m.type === 'job-done') {
    slot.busy = false; slot.job = null;
    renderJob(job); updateOverall(); updateDownloadCard();
    pump();
  }
}

// ---------------- tabela ----------------
const renderTimers = new Map();
function throttleRender(job) {
  if (renderTimers.has(job.id)) return;
  renderTimers.set(job.id, setTimeout(() => { renderTimers.delete(job.id); renderJob(job); updateOverall(); }, 150));
}
function statusChip(status, stage) {
  const map = {
    queued: ['', 'st_queued'], running: ['run', 'st_' + (stage || 'scan')], done: ['ok', 'st_done'], alert: ['warn', 'st_alert'],
    error: ['err', 'st_error'], cancelled: ['', 'st_cancelled'], skipped: ['', 'st_skipped'], pass: ['ok', 'st_pass'],
  };
  const [cls, key] = map[status] || ['', 'st_queued'];
  return `<span class="chip ${cls}">${esc(t(key))}</span>`;
}
function structChips(rep) {
  if (!rep) return '<span class="muted">—</span>';
  const L = rep.landmarks || {};
  const c = (ok, key) => `<span class="chip ${ok ? 'ok' : 'warn'}" title="${esc(ok ? '' : t('outOfVolume'))}">${ok ? '✓' : '–'} ${esc(t(key))}</span>`;
  return `<div class="structs">${c(L.eyes && L.eyes.length === 2, 'eyes')}${c(!!L.nose, 'nose')}${c(!!L.mouth, 'mouth')}${c(!!L.chin, 'chin')}</div>`;
}
function seriesCell(s) {
  const c = s.summary && s.summary.chosen;
  if (!c) return '<span class="muted">—</span>';
  const tags = [c.contrast ? t('contrastTag') : t('noContrastTag'), (c.kernel ? t('kernelTag') + ' ' + c.kernel : ''), c.n + ' ' + t('slices'), (c.spacing ? c.spacing.toFixed(2) + ' mm' : '')].filter(Boolean).join(' · ');
  return `<div>${esc(c.desc || '—')}</div><div class="meta">${esc(tags)}</div>`;
}
function reasonsText(summary) {
  if (!summary || !summary.candidates) return '';
  const bad = summary.candidates.filter((c) => !c.ok);
  if (!bad.length) return '';
  return t('reasons') + ': ' + bad.slice(0, 6).map((c) => `${c.desc || '—'} (${c.reasons.map((r) => t('r_' + r)).join(', ')})`).join('; ');
}
function rowHtml(job, s, idx, multi) {
  const status = s ? s.status : job.state === 'running' ? 'running' : job.state === 'error' ? 'error' : job.state;
  const stage = s ? s.stage : job.stage;
  const frac = s ? s.frac : job.frac;
  let detail = '';
  const errKey = s ? s.error : job.error;
  if (status === 'error' || status === 'alert') {
    const d = s ? s.detail : job.detail;
    detail = `<div class="st-detail ${status === 'alert' ? 'warn' : 'err'}">${esc(t('err_' + (errKey || 'unknown'), { d }))}</div>`;
    if (errKey === 'noseries' && s) detail += `<div class="st-detail">${esc(reasonsText(s.summary))}</div>`;
  }
  if (s && s.status === 'done' && s.summary && s.summary.onlyContrast) detail += `<div class="st-detail warn">${esc(t('alertOnlyContrast'))}</div>`;
  if (s && s.status === 'done' && s.report) detail += `<div class="st-detail">${esc(s.report.changed.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US'))} ${esc(t('voxels'))} · ${esc(fmtTime(s.report.ms))}</div>`;
  const prog = status === 'running' ? `<div class="bar sm" style="margin-top:6px"><i style="width:${Math.round((frac || 0) * 100)}%"></i></div>` : '';
  let out = '<span class="muted">—</span>';
  if (s && (s.status === 'done' || s.status === 'pass') && s.code) {
    out = `<div class="outname">${esc(s.code)}.zip</div><div class="meta">${esc(fmtBytes(s.outSize))}${s.inDest ? ' · ' + esc(t('savedInFolder')) + ' ' + esc(state.destName) : ''}</div>`;
  }
  const actions = [];
  if (s && s.previewKey) actions.push(`<button type="button" class="btn sm" data-view="${esc(s.previewKey)}">${esc(t('view'))}</button>`);
  if (s && (s.status === 'done' || s.status === 'pass') && s.outHandle && !s.inDest && !previewHost()) actions.push(`<button type="button" class="btn sm" data-dl="${job.id}_${s.idx}">${esc(t('download'))}</button>`);
  const thumb = s && s.thumb ? `<img class="thumb" alt="" src="${s.thumb}">` : '';
  const fname = esc(job.name) + (multi ? ` <span class="meta">· ${idx + 1}/${job.studies.length}</span>` : '');
  return `<tr>
    <td class="num">${job.num}</td>
    <td><div class="fname">${fname}</div><div class="meta">${esc(fmtBytes(job.size))}</div></td>
    <td>${s ? seriesCell(s) : '<span class="muted">—</span>'}</td>
    <td>${s ? structChips(s.report) : '<span class="muted">—</span>'}</td>
    <td>${statusChip(status, stage)}${prog}${detail}</td>
    <td>${out}</td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap">${thumb}${actions.join('')}</div></td>
  </tr>`;
}
function renderJob(job) {
  let tb = document.getElementById('job-' + job.id);
  if (!tb) { renderAllRows(); return; }
  tb.innerHTML = jobHtml(job);
}
function jobHtml(job) {
  if (!job.studies.length) return rowHtml(job, null, 0, false);
  return job.studies.map((s, i) => rowHtml(job, s, i, job.studies.length > 1)).join('');
}
function renderAllRows() {
  const table = $('#cardQueue table');
  for (const tb of $$('#cardQueue tbody[data-job]')) tb.remove();
  $('#emptyBody').classList.toggle('hidden', state.jobs.length > 0);
  state.jobs.forEach((j, i) => {
    j.num = i + 1;
    const tb = document.createElement('tbody');
    tb.id = 'job-' + j.id; tb.dataset.job = String(j.id);
    tb.innerHTML = jobHtml(j);
    table.appendChild(tb);
  });
}
$('#cardQueue').addEventListener('click', async (e) => {
  const v = e.target.closest('[data-view]');
  if (v) { openViewer(v.dataset.view); return; }
  const d = e.target.closest('[data-dl]');
  if (d) {
    const [jid, si] = d.dataset.dl.split('_').map(Number);
    const job = state.jobs.find((j) => j.id === jid); const s = job && job.studies[si];
    if (s && s.outHandle) { const f = await s.outHandle.getFile(); downloadBlob(f, s.outName); }
  }
});
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function allStudies() { const out = []; for (const j of state.jobs) for (const s of j.studies) out.push({ job: j, s }); return out; }
function updateOverall() {
  const studies = allStudies();
  const fin = ['done', 'alert', 'error', 'pass', 'skipped', 'cancelled'];
  let done = 0, alert = 0, err = 0;
  for (const { s } of studies) { if (s.status === 'done' || s.status === 'pass') done++; else if (s.status === 'alert') alert++; else if (s.status === 'error') err++; }
  for (const j of state.jobs) if (j.state === 'error' && !j.studies.length) err++;
  const q = state.jobs.filter((j) => j.state === 'queued').length;
  const totalUnits = state.jobs.filter((j) => j.state !== 'cancelled').length;
  let progressUnits = 0;
  for (const j of state.jobs) {
    if (j.state === 'cancelled') continue;
    if (j.state === 'done' || j.state === 'error') { progressUnits += 1; continue; }
    if (j.state === 'running') {
      const n = Math.max(1, j.studies.length);
      let acc = 0;
      j.studies.forEach((s) => { acc += fin.includes(s.status) ? 1 : s.status === 'running' ? stageFrac(s.stage, s.frac) : 0; });
      progressUnits += j.studies.length ? acc / n : 0.05 * (j.frac || 0);
    }
  }
  const pct = totalUnits ? Math.round(progressUnits / totalUnits * 100) : 0;
  $('#overallBar').style.width = pct + '%';
  $('#overallText').textContent = state.jobs.length ? t('summary', { done, alert, err, q }) + ` · ${pct}%` : '';
  if (state.times.length && (q || state.jobs.some((j) => j.state === 'running'))) {
    const avg = state.times.reduce((a, b) => a + b, 0) / state.times.length;
    const remaining = Math.max(0, totalUnits - progressUnits) * avg / POOL;
    $('#etaText').textContent = t('eta', { t: fmtTime(remaining) });
  } else $('#etaText').textContent = '';
}
function stageFrac(stage, f) {
  const w = { scan: [0, 0.1], decode: [0.1, 0.55], analyze: [0.55, 0.7], write: [0.7, 1] }[stage] || [0, 0.1];
  return w[0] + (w[1] - w[0]) * (f || 0);
}

// ---------------- prévias (OPFS) ----------------
const previewCache = new Map();
const memOnly = new Set();
function packPreview(p) {
  const parts = [], meta = {};
  const add = (key, obj) => {
    if (!obj) return;
    const m = { ...obj }; delete m.data; m.off = parts.reduce((a, b) => a + b.length, 0); m.len = obj.data.length;
    parts.push(obj.data); meta[key] = m;
  };
  add('before', p.before); add('after', p.after);
  if (p.qcBefore) { add('qcBsag', p.qcBefore.sag); add('qcBax', p.qcBefore.ax); }
  if (p.qcAfter) { add('qcAsag', p.qcAfter.sag); add('qcAax', p.qcAfter.ax); }
  meta.spacing = p.spacing || null;
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + head.length + parts.reduce((a, b) => a + b.length, 0));
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4); let p0 = 4 + head.length;
  for (const b of parts) { out.set(b, p0); p0 += b.length; }
  return out;
}
function unpackPreview(u8) {
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)));
  const base = 4 + hl;
  const get = (k) => meta[k] ? { ...meta[k], data: u8.slice(base + meta[k].off, base + meta[k].off + meta[k].len) } : null;
  return {
    before: get('before'), after: get('after'),
    qcBefore: meta.qcBsag ? { sag: get('qcBsag'), ax: get('qcBax') } : null,
    qcAfter: meta.qcAsag ? { sag: get('qcAsag'), ax: get('qcAax') } : null,
    spacing: meta.spacing,
  };
}
async function savePreview(key, p) {
  try {
    const dir = await opfsDir('prev');
    const fh = await dir.getFileHandle(key + '.bin', { create: true });
    const w = await fh.createWritable(); await w.write(packPreview(p)); await w.close();
  } catch (e) {
    previewCache.set(key, p); memOnly.add(key); // sem OPFS: mantém em memória
  }
}
async function loadPreview(key) {
  if (previewCache.has(key)) return previewCache.get(key);
  const dir = await opfsDir('prev');
  const fh = await dir.getFileHandle(key + '.bin');
  const f = await fh.getFile();
  const p = unpackPreview(new Uint8Array(await f.arrayBuffer()));
  if (previewCache.size > 3) { const old = [...previewCache.keys()].find((k) => !memOnly.has(k)); if (old) previewCache.delete(old); }
  previewCache.set(key, p);
  return p;
}

// ---------------- renderização ----------------
// Dois workers: "fast" só faz quadros em 1/5 da resolução durante a rotação; "full" faz a imagem final
// e as miniaturas. Assim um quadro completo em andamento nunca atrasa a resposta ao movimento.
const renderWorkers = { fast: null, full: null };
let renderSeq = 0;
const rw = {
  fast: { before: { busy: false, pending: null }, after: { busy: false, pending: null } },
  full: { before: { busy: false, pending: null }, after: { busy: false, pending: null } },
  thumb: { busy: false },
};
const drawn = { before: 0, after: 0 };
const thumbQueue = [];
function makeRenderWorker(kind) {
  const w = new Worker(blobUrl(renderCode));
  w.onmessage = (ev) => onRenderMsg(kind, ev.data);
  w.onerror = (ev) => {
    ev.preventDefault();
    for (const k of ['before', 'after']) { rw[kind][k].busy = false; rw[kind][k].pending = null; }
    if (kind === 'full') { rw.thumb.busy = false; thumbQueue.length = 0; }
    try { w.terminate(); } catch (e) { /* ok */ }
    renderWorkers[kind] = null;
    if (viewer.current) { const k = viewer.current; viewer.current = null; openViewer(k, true); }
  };
  return w;
}
function getRenderWorker(kind = 'full') {
  if (!renderWorkers[kind]) renderWorkers[kind] = makeRenderWorker(kind);
  return renderWorkers[kind];
}
function broadcast(msg) { getRenderWorker('fast').postMessage(msg); getRenderWorker('full').postMessage(msg); }
const viewer = { current: null, yaw: 0, pitch: 0, low: false, idleTimer: null, hasAfter: false, interactSeq: 0 };
const LOW = 0.2; // 1/5 da resolução durante a rotação
function canvasFullSize(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return Math.max(120, Math.min(560, Math.round((r.width || 420) * dpr)));
}
function requestRender(key, low) {
  if (!viewer.current) return;
  const cv = key === 'before' ? $('#cvBefore') : $('#cvAfter');
  if (key === 'after' && !viewer.hasAfter) return;
  const kind = low ? 'fast' : 'full';
  const full = canvasFullSize(cv);
  const size = low ? Math.max(24, Math.round(full * LOW)) : full;
  const req = { type: 'render', key: viewer.current + ':' + key, w: size, h: size, yaw: viewer.yaw, pitch: viewer.pitch, bg: [0, 0, 0], bgAlpha: 0, tint: [222, 200, 182], seq: ++renderSeq };
  const slot = rw[kind][key];
  if (slot.busy) { slot.pending = true; return; }
  slot.busy = true; slot.req = req;
  getRenderWorker(kind).postMessage(req);
}
function onRenderMsg(kind, m) {
  if (m.type !== 'image') return;
  if (m.key.startsWith('thumb:')) {
    rw.thumb.busy = false;
    const job = thumbQueue.shift();
    if (job && !m.missing) job.done(m);
    if (thumbQueue.length) startThumb();
    return;
  }
  const key = m.key.endsWith(':before') ? 'before' : 'after';
  const slot = rw[kind][key];
  slot.busy = false;
  const stale = kind === 'full' && m.seq < viewer.interactSeq; // quadro completo pedido antes do último movimento
  if (!m.missing && !stale && m.seq > drawn[key] && m.key === viewer.current + ':' + key) {
    const cv = key === 'before' ? $('#cvBefore') : $('#cvAfter');
    if (cv.width !== m.w) { cv.width = m.w; cv.height = m.h; }
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data.buffer), m.w, m.h), 0, 0);
    cv.classList.toggle('low', kind === 'fast');
    cv.dataset.res = kind === 'fast' ? 'low' : 'full';
    drawn[key] = m.seq;
  }
  if (slot.pending) { slot.pending = false; requestRender(key, kind === 'fast'); }
  else if (stale && !viewer.low) requestRender(key, false);
}
function requestFullRender() { requestRender('before', false); requestRender('after', false); }
function interact() {
  viewer.low = true;
  viewer.interactSeq = renderSeq + 1;
  requestRender('before', true); requestRender('after', true);
  clearTimeout(viewer.idleTimer);
  viewer.idleTimer = setTimeout(() => { viewer.low = false; requestFullRender(); }, 180);
}
function setYaw(v) {
  viewer.yaw = Math.max(-80, Math.min(80, Math.round(v)));
  $('#yaw').value = String(viewer.yaw); $('#yawVal').textContent = viewer.yaw + '°';
  interact();
}
function setPitch(v) {
  viewer.pitch = Math.max(-30, Math.min(30, Math.round(v)));
  $('#pitch').value = String(viewer.pitch); $('#pitchVal').textContent = viewer.pitch + '°';
  interact();
}
$('#yaw').addEventListener('input', (e) => setYaw(+e.target.value));
$('#pitch').addEventListener('input', (e) => setPitch(+e.target.value));
$('#rotFront').addEventListener('click', () => { viewer.yaw = 0; viewer.pitch = 0; setPitch(0); setYaw(0); });
function holdButton(btn, delta) {
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(); setYaw(viewer.yaw + delta); timer = setInterval(() => setYaw(viewer.yaw + delta), 40); btn.setPointerCapture && btn.setPointerCapture(e.pointerId); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) btn.addEventListener(ev, stop);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setYaw(viewer.yaw + delta * 2); } });
}
holdButton($('#rotL'), -3); holdButton($('#rotR'), 3);
for (const cv of [$('#cvBefore'), $('#cvAfter')]) {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: viewer.yaw, pitch: viewer.pitch }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = cv.getBoundingClientRect().width || 300;
    const ny = drag.yaw + (e.clientX - drag.x) / w * 160;
    const np = drag.pitch - (e.clientY - drag.y) / w * 60;
    viewer.yaw = Math.max(-80, Math.min(80, Math.round(ny))); viewer.pitch = Math.max(-30, Math.min(30, Math.round(np)));
    $('#yaw').value = String(viewer.yaw); $('#yawVal').textContent = viewer.yaw + '°';
    $('#pitch').value = String(viewer.pitch); $('#pitchVal').textContent = viewer.pitch + '°';
    interact();
  });
  const end = () => { drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
let resizeT = null;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { requestFullRender(); drawQC(); }, 200); });

function viewerItems() { return allStudies().filter(({ s }) => s.previewKey); }
function refreshViewerSelect() {
  const items = viewerItems();
  const sel = $('#viewerSelect');
  $('#viewerEmpty').classList.toggle('hidden', items.length > 0);
  $('#viewerBody').classList.toggle('hidden', items.length === 0);
  const cur = viewer.current;
  sel.innerHTML = items.map(({ job, s }) => `<option value="${esc(s.previewKey)}">${job.num}. ${esc(s.code || job.name)}${s.status === 'alert' ? ' — ' + esc(t('st_alert')) : ''}</option>`).join('');
  if (cur && items.some(({ s }) => s.previewKey === cur)) sel.value = cur;
  else if (items.length && !cur) openViewer(items[0].s.previewKey, true);
}
$('#viewerSelect').addEventListener('change', (e) => openViewer(e.target.value));
let qcData = null;
let viewerToken = 0;
async function openViewer(key, silent) {
  const item = allStudies().find(({ s }) => s.previewKey === key);
  if (!item) return;
  const token = ++viewerToken;
  let p;
  try { p = await loadPreview(key); } catch (e) { toast(t('err_unknown')); return; }
  if (token !== viewerToken) return; // outro exame foi escolhido enquanto carregava
  if (viewer.current && viewer.current !== key) { broadcast({ type: 'drop', key: viewer.current + ':before' }); broadcast({ type: 'drop', key: viewer.current + ':after' }); }
  viewer.current = key; viewer.hasAfter = !!p.after; viewer.study = item.s;
  broadcast({ type: 'set', key: key + ':before', prev: p.before });
  if (p.after) broadcast({ type: 'set', key: key + ':after', prev: p.after });
  $('#noAfter').classList.toggle('hidden', !!p.after);
  $('#cvAfter').classList.toggle('hidden', !p.after);
  $('#viewerSelect').value = key;
  qcData = { p, report: item.s.report };
  requestFullRender(); drawQC(); updateLandmarkChips();
  if (!silent) $('#cardViewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function updateLandmarkChips() {
  const box = $('#lmChips');
  if (!viewer.study || !viewer.study.report) { box.innerHTML = ''; return; }
  box.innerHTML = structChips(viewer.study.report);
}
function drawGray(cv, img, aspect, marks) {
  if (!img) { cv.width = 10; cv.height = 10; cv.getContext('2d').clearRect(0, 0, 10, 10); return; }
  const W = img.w, H = img.h;
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  const id = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) { const v = img.data[i]; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  tmp.getContext('2d').putImageData(id, 0, 0);
  const outW = Math.min(400, W);
  const outH = Math.max(1, Math.round(outW * (H * aspect) / W));
  cv.width = outW; cv.height = outH;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, outW, outH);
  if (marks) {
    ctx.lineWidth = 2;
    for (const mk of marks) {
      const x = mk.x / W * outW, y = mk.y / H * outH;
      ctx.strokeStyle = mk.color; ctx.beginPath();
      if (mk.r) ctx.ellipse(x, y, mk.r / W * outW, mk.r / W * outW, 0, 0, Math.PI * 2);
      else { ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); }
      ctx.stroke();
    }
  }
}
function drawQC() {
  if (!qcData) return;
  const { p, report } = qcData;
  const sp = p.spacing || [1, 1, 1];
  const L = report && report.landmarks;
  const sagMarks = [], axMarks = [];
  if (L && p.qcBefore) {
    const H = p.qcBefore.sag.h;
    if (L.nose) sagMarks.push({ x: L.nose.y, y: H - 1 - L.nose.z, color: '#ffb000' });
    if (L.mouth) sagMarks.push({ x: L.mouth.y, y: H - 1 - L.mouth.z, color: '#00c2ff' });
    if (L.chin) sagMarks.push({ x: L.chin.y, y: H - 1 - L.chin.z, color: '#a970ff' });
    if (L.eyes) for (const e of L.eyes) axMarks.push({ x: e.x, y: e.y, r: e.r / sp[0], color: '#3fd16b' });
  }
  const aspSag = sp[2] / sp[1], aspAx = sp[1] / sp[0];
  drawGray($('#qcSagB'), p.qcBefore && p.qcBefore.sag, aspSag, sagMarks);
  drawGray($('#qcSagA'), p.qcAfter && p.qcAfter.sag, aspSag);
  drawGray($('#qcAxB'), p.qcBefore && p.qcBefore.ax, aspAx, axMarks);
  drawGray($('#qcAxA'), p.qcAfter && p.qcAfter.ax, aspAx);
}

// miniatura do resultado desidentificado
function makeThumb(s, prev) {
  thumbQueue.push({
    key: 'thumb:' + s.previewKey, prev,
    done: (m) => {
      const c = document.createElement('canvas'); c.width = m.w; c.height = m.h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data.buffer), m.w, m.h), 0, 0);
      s.thumb = c.toDataURL('image/png');
      getRenderWorker('full').postMessage({ type: 'drop', key: 'thumb:' + s.previewKey });
      const job = state.jobs.find((j) => j.studies.includes(s)); if (job) renderJob(job);
    },
  });
  if (thumbQueue.length === 1) startThumb();
}
function startThumb() {
  const j = thumbQueue[0]; if (!j) return;
  const w = getRenderWorker('full');
  w.postMessage({ type: 'set', key: j.key, prev: j.prev });
  rw.thumb.busy = true;
  w.postMessage({ type: 'render', key: j.key, w: 88, h: 88, yaw: 25, pitch: 0, bg: [0, 0, 0], bgAlpha: 0, tint: [222, 200, 182], seq: ++renderSeq });
}

// ---------------- download ----------------
function readyStudies() {
  return allStudies().filter(({ s }) => (s.status === 'done' || s.status === 'pass') && s.outHandle && s.decision !== 'exclude');
}
function updateDownloadCard() {
  const ready = allStudies().filter(({ s }) => (s.status === 'done' || s.status === 'pass') && s.outHandle);
  const alerts = allStudies().filter(({ s }) => s.status === 'alert');
  const size = ready.reduce((a, { s }) => a + (s.outSize || 0), 0);
  const busy = state.jobs.some((j) => j.state === 'running') || dlBusy;
  const blocked = previewHost();
  $('#dlPreview').classList.toggle('hidden', !blocked);
  $('#btnDlAll').disabled = blocked || busy || (ready.length + alerts.length === 0);
  $('#dlCounts').textContent = ready.length ? t('dlCounts', { n: ready.length, size: fmtBytes(size) }) : t('dlNone');
  const csv = settings().csv;
  $('#btnDlCsv').classList.toggle('hidden', !csv);
  $('#btnDlCsv').disabled = blocked || busy || allStudies().length === 0;
  $('#csvNote').classList.toggle('hidden', !csv);
}
$('#optCsv').addEventListener('change', updateDownloadCard);

let dlBusy = false;
const passWaiters = new Map();
$('#btnDlAll').addEventListener('click', async () => {
  const pend = allStudies().filter(({ s }) => s.status === 'alert' || (s.status === 'done' && s.summary && s.summary.onlyContrast));
  if (pend.length) {
    const ok = await askApprovals(pend);
    if (!ok) return;
  }
  await runPassthroughs();
  await downloadAll();
});
function askApprovals(items) {
  return new Promise((resolve) => {
    const dlg = $('#dlgApprove');
    $('#apList').innerHTML = items.map(({ job, s }, i) => {
      const noFace = s.status === 'alert';
      const def = s.decision || (noFace ? 'exclude' : 'include');
      return `<div class="apr" data-i="${i}">
        <div><strong>${job.num}. ${esc(job.name)}</strong>${job.studies.length > 1 ? ' · ' + (s.idx + 1) + '/' + job.studies.length : ''}</div>
        <div class="small muted">${esc(noFace ? t('approveNoFace') + ' ' + t('err_' + (s.error || 'noface')) : t('approveContrast'))}</div>
        <div class="opts">
          <label><input type="radio" name="ap${i}" value="include" ${def === 'include' ? 'checked' : ''}> ${esc(noFace ? t('optIncludePass') : t('optInclude'))}</label>
          <label><input type="radio" name="ap${i}" value="exclude" ${def === 'exclude' ? 'checked' : ''}> ${esc(t('optExclude'))}</label>
        </div></div>`;
    }).join('');
    const done = (ok) => {
      if (ok) items.forEach(({ s }, i) => { const v = (document.querySelector(`input[name=ap${i}]:checked`) || {}).value; s.decision = v || 'exclude'; });
      dlg.close(); $('#apGo').onclick = null; $('#apCancel').onclick = null; dlg.oncancel = null;
      resolve(ok);
    };
    $('#apGo').onclick = () => done(true);
    $('#apCancel').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
  });
}
async function runPassthroughs() {
  const todo = allStudies().filter(({ s }) => s.status === 'alert' && s.decision === 'include' && !s.passDone);
  if (!todo.length) return;
  dlBusy = true; updateDownloadCard();
  let w = null;
  const slot = { w: null, busy: true, job: null };
  const failAll = (code) => { for (const [k, cb] of passWaiters) { passWaiters.delete(k); cb({ type: 'pass-error', code }); } };
  const spawn = () => {
    w = makeEngineWorker(); slot.w = w;
    slot.chain = Promise.resolve();
    w.onmessage = (ev) => { slot.chain = slot.chain.then(() => onWorkerMsg(slot, ev.data)).catch((e) => console.warn(e)); };
    w.onerror = (ev) => { ev.preventDefault(); failAll('memory'); try { w.terminate(); } catch (e) { /* ok */ } w = null; };
  };
  try {
    for (const { job, s } of todo) {
      if (!w) spawn();
      const st = settings();
      try {
        let base;
        if (st.naming === 'acc' && sanitizeName(s.summary && s.summary.accession)) base = sanitizeName(s.summary.accession);
        else { state.seq++; base = 'DEFACE_' + String(state.seq).padStart(3, '0'); }
        const dir = state.destDir || await opfsDir('out');
        const name = await uniqueName(dir, base);
        const fh = await dir.getFileHandle(name + '.zip', { create: true });
        s.sink = new BufferedSink(await fh.createWritable()); s.zw = new ZipWriter(s.sink);
        s.outDir = dir; s.outName = name + '.zip'; s.outHandle = fh; s.code = name; s.inDest = !!state.destDir;
        s.status = 'running'; s.stage = 'decode'; renderJob(job);
        const res = await new Promise((resolve) => {
          passWaiters.set(job.id + '_' + s.idx, resolve);
          w.postMessage({ type: 'passthrough', id: job.id, file: job.file, study: s.idx, opts: { anonymize: st.anonymize, code: name, folder: name } });
        });
        if (res.type !== 'pass-done' || s.writeError) throw Object.assign(new Error(res.detail || s.writeError || ''), { code: res.code || 'write' });
        s.outSize = await s.zw.close(); s.status = 'pass'; s.passDone = true;
      } catch (e) {
        if (s.sink) await s.sink.abort();
        await removeOut(s);
        if (s.code) state.usedNames.delete(s.code.toLowerCase());
        s.code = null; s.status = 'alert'; s.decision = 'exclude'; s.writeError = null;
        toast(t('err_' + (e.code || 'unknown'), { d: e.message || '' }));
      }
      s.sink = null; s.zw = null;
      renderJob(job);
    }
  } finally { if (w) w.terminate(); dlBusy = false; updateDownloadCard(); }
}
async function downloadAll() {
  const items = readyStudies();
  if (!items.length) { showMsg($('#dlMsg'), 'warn', t('dlNone')); return; }
  const name = `DEFACE_lote_${stamp()}.zip`;
  let handle = null, inFolder = false, tmp = false;
  try {
    if (state.destDir) { handle = await state.destDir.getFileHandle(name, { create: true }); inFolder = true; }
    else if (typeof window.showSaveFilePicker === 'function') {
      try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] }); }
      catch (e) { if (e && e.name === 'AbortError') { showMsg($('#dlMsg'), 'info', t('dlCancelled')); return; } handle = null; }
    }
    if (!handle) { handle = await (await opfsDir('tmp')).getFileHandle(name, { create: true }); tmp = true; }
  } catch (e) { showMsg($('#dlMsg'), 'err', t('dlError', { d: e && e.message || e })); return; }
  dlBusy = true; updateDownloadCard(); hideMsg($('#dlMsg'));
  $('#dlProg').classList.remove('hidden');
  const total = items.reduce((a, { s }) => a + (s.outSize || 0), 0) || 1;
  let done = 0;
  let sink;
  try {
    sink = new BufferedSink(await handle.createWritable());
    const zw = new ZipWriter(sink);
    for (const { s } of items) {
      const file = await s.outHandle.getFile();
      const src = blobSource(file);
      const entries = await listZip(src);
      for (const e of entries) {
        const raw = await readZipEntry(src, e, true);
        await zw.addRaw(e.name, { crc: e.crc, csize: e.csize, usize: e.usize, method: e.method, data: raw });
        done += raw.length;
        const p = Math.min(99, Math.round(done / total * 100));
        $('#dlBar').style.width = p + '%'; $('#dlText').textContent = t('dlProgress', { p });
      }
    }
    await zw.close();
    $('#dlBar').style.width = '100%'; $('#dlText').textContent = t('dlProgress', { p: 100 });
    if (tmp) {
      downloadBlob(await handle.getFile(), name); showMsg($('#dlMsg'), 'ok', t('dlDone', { name }));
      setTimeout(async () => { try { await (await opfsDir('tmp')).removeEntry(name); } catch (e) { /* já removido */ } }, 120000);
    }
    else if (inFolder) showMsg($('#dlMsg'), 'ok', t('dlSavedFolder', { dir: state.destName, name }));
    else showMsg($('#dlMsg'), 'ok', t('dlDone', { name: handle.name || name }));
    if (settings().csv) await saveCsv();
  } catch (e) {
    if (sink) await sink.abort();
    try { if (inFolder) await state.destDir.removeEntry(name); else if (tmp) await (await opfsDir('tmp')).removeEntry(name); else if (handle && handle.remove) await handle.remove(); } catch (e2) { /* nada a remover */ }
    showMsg($('#dlMsg'), 'err', isQuota(e) ? t('err_quota') : t('dlError', { d: e && e.message || e }));
  } finally {
    dlBusy = false; updateDownloadCard();
    setTimeout(() => $('#dlProg').classList.add('hidden'), 1500);
  }
}
function csvText() {
  const q = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
  const head = ['codigo_saida', 'arquivo_origem', 'nome_paciente', 'id_paciente', 'numero_acesso', 'data_estudo', 'nascimento', 'serie', 'kernel', 'contraste', 'cortes', 'situacao'];
  const rows = [head.map(q).join(';')];
  const sit = (s) => {
    if (s.decision === 'exclude') return 'excluido';
    return ({ done: 'concluido', pass: 'incluido_sem_alterar_face', alert: 'face_nao_identificada', error: 'erro', cancelled: 'cancelado', queued: 'na_fila', running: 'em_processamento' })[s.status] || s.status;
  };
  for (const j of state.jobs) {
    if (!j.studies.length) { rows.push(['', j.name, '', '', '', '', '', '', '', '', '', j.state === 'error' ? 'erro: ' + (j.error || '') : j.state].map(q).join(';')); continue; }
    for (const s of j.studies) {
      const c = s.summary && s.summary.chosen;
      const m = s.summary || {};
      rows.push([s.code || '', j.name, m.patientName, m.patientID, m.accession, m.studyDate, m.birth, c && c.desc, c && c.kernel, c ? (c.contrast ? 'sim' : 'nao') : '', c && c.n, sit(s) + (s.status === 'error' && s.error ? ': ' + s.error : '')].map(q).join(';'));
    }
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}
async function saveCsv() {
  const name = `DEFACE_correspondencia_${stamp()}.csv`;
  const blob = new Blob([csvText()], { type: 'text/csv;charset=utf-8' });
  if (state.destDir) {
    const fh = await state.destDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    toast(t('dlSavedFolder', { dir: state.destName, name }));
  } else downloadBlob(blob, name);
}
$('#btnDlCsv').addEventListener('click', () => saveCsv().catch((e) => showMsg($('#dlMsg'), 'err', t('dlError', { d: e && e.message || e }))));

// ---------------- início ----------------
for (const b of $$('#langSeg button')) b.addEventListener('click', () => { lang = b.dataset.lang; store.set('lang', lang); applyLang(); });
for (const b of $$('#themeSeg button')) b.addEventListener('click', () => { themePref = b.dataset.themeBtn; store.set('theme', themePref); applyTheme(); });
window.addEventListener('beforeunload', (e) => {
  const busy = state.jobs.some((j) => j.state === 'running') || dlBusy;
  const unsaved = !state.destDir && allStudies().some(({ s }) => s.status === 'done');
  if (busy || unsaved) { e.preventDefault(); e.returnValue = ''; }
});
window.DefaceCT = { version: VERSION, state, _t: t };
(async () => {
  await opfsInit();
  applyTheme(); applyLang();
  updateButtons();
  initAccess();
})();
