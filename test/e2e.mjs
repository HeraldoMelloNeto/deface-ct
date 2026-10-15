// Teste de ponta a ponta no Chromium (Playwright): acesso por e-mail, lote, visualização, download, temas e idiomas.
// Uso: node test/e2e.mjs [--mode functions|none|unconfigured] [--files a.zip,b.zip] [--out dir] [--quick]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './server.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => { if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return a; }, []));
const mode = args.mode || 'functions';
const outDir = path.resolve(args.out || 'out/e2e');
fs.mkdirSync(outDir, { recursive: true });
const files = (args.files || '').split(',').filter(Boolean).map((f) => path.resolve(f));
const port = 8700 + Math.floor(Math.random() * 200);
const srv = await startServer({ port, mode, root: path.resolve('.') });
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let browser, ctx;
if (args.persistent) {
  const prof = path.join(outDir, 'profile'); fs.rmSync(prof, { recursive: true, force: true });
  ctx = await chromium.launchPersistentContext(prof, { executablePath: exe, args: ['--no-sandbox'], viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  browser = { close: () => ctx.close() };
} else {
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
}
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('crash', () => errors.push('crash'));
// seletores de pasta/arquivo simulados com OPFS (o diálogo nativo não pode ser automatizado)
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('picked-folder', { create: true });
    d.requestPermission = async () => 'granted';
    return d;
  };
  window.showSaveFilePicker = async (o) => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('saved', { create: true });
    return d.getFileHandle(o.suggestedName, { create: true });
  };
});
const log = (...a) => console.log('[e2e]', ...a);
const shot = async (n) => { await page.screenshot({ path: path.join(outDir, n + '.png'), fullPage: true }); };
const st = () => page.evaluate(() => {
  const s = window.DefaceCT.state;
  return { access: s.access, running: s.running, jobs: s.jobs.map((j) => ({ name: j.name, state: j.state, error: j.error, studies: j.studies.map((x) => ({ status: x.status, error: x.error, code: x.code, changed: x.report && x.report.changed, decision: x.decision })) })) };
});

await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.DefaceCT && window.DefaceCT.state.access !== 'checking', null, { timeout: 20000 });
log('acesso inicial:', (await st()).access);

if (mode === 'functions') {
  await shot('01_acesso');
  // e-mail inválido
  await page.fill('#email', 'invalido');
  await page.check('#consent');
  await page.click('#btnSend');
  await page.waitForSelector('#accMsg1:not(.hidden)');
  await page.fill('#email', 'Teste.Usuario@Exemplo.com');
  await page.click('#btnSend');
  await page.waitForSelector('#accCode:not(.hidden)');
  const code = srv.sent[srv.sent.length - 1].subject.match(/(\d{6})/)[1];
  // código errado
  await page.fill('#code', code === '000000' ? '111111' : '000000');
  await page.waitForSelector('#accMsg2:not(.hidden)');
  log('msg código errado:', await page.textContent('#accMsg2'));
  await page.fill('#code', code);
  await page.waitForFunction(() => window.DefaceCT.state.access === 'verified', null, { timeout: 10000 });
  log('verificado:', await page.textContent('#verEmail'));
  // recarregar mantém a sessão
  await page.reload();
  await page.waitForFunction(() => window.DefaceCT && window.DefaceCT.state.access === 'verified', null, { timeout: 15000 });
  log('sessão mantida após recarregar');
}
if (mode === 'unconfigured') {
  await shot('01_unconfigured');
  const locked = await page.evaluate(() => document.querySelector('#drop').classList.contains('locked'));
  log('bloqueado sem configuração:', locked);
  if (!locked) errors.push('esperava bloqueio');
}

if (files.length && mode !== 'unconfigured') {
  // pasta de destino (simulada)
  if (!args['no-dest']) {
    await page.click('#btnDest');
    await page.waitForFunction(() => !!window.DefaceCT.state.destDir);
    log('pasta escolhida');
  }
  if (args.acc) await page.check('input[name=naming][value=acc]');
  if (args.csv) await page.check('#optCsv');
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction((n) => window.DefaceCT.state.jobs.length === n, Math.min(100, files.length));
  await shot('02_fila');
  const t0 = Date.now();
  await page.click('#btnStart');
  // durante o processamento: alternar tema e idioma não pode quebrar nada
  await page.waitForTimeout(800);
  await page.click('[data-theme-btn=light]');
  await page.click('[data-lang=en]');
  await page.waitForTimeout(300);
  await page.click('[data-lang=pt]');
  await page.click('[data-theme-btn=dark]');
  await page.waitForFunction(() => { const s = window.DefaceCT.state; return s.jobs.every((j) => ['done', 'error', 'cancelled'].includes(j.state)); }, null, { timeout: 60 * 60 * 1000, polling: 1000 });
  const s = await st();
  log('processamento concluído em', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const j of s.jobs) log(' ', j.name, j.state, j.error || '', JSON.stringify(j.studies));
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(s, null, 1));
  await page.waitForTimeout(800);
  await shot('03_concluido_escuro');

  if (!args.quick) {
    // visualizador: abrir o primeiro exame concluído
    const viewBtn = await page.$('[data-view]');
    if (viewBtn) {
      await viewBtn.click();
      await page.waitForTimeout(1500);
      await shot('04_viewer');
      // girar segurando o botão: deve renderizar em 1/5 e voltar à resolução completa
      await page.$eval('#rotR', (b) => b.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__res = []; const c = document.querySelector('#cvBefore'); new MutationObserver(() => window.__res.push([c.dataset.res, c.width])).observe(c, { attributes: true }); });
      const box = await page.$eval('#rotR', (b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(box.x, box.y); await page.mouse.down();
      await page.waitForTimeout(800);
      await page.mouse.up();
      let fullW = 0;
      const resLog = await page.evaluate(() => window.__res);
      const lows = resLog.filter((r) => r[0] === 'low');
      const lowSeen = lows.length;
      log('registro de resolução:', JSON.stringify(resLog).slice(0, 300));
      if (lows.length) log('largura em baixa resolução:', lows[0][1]);
      await page.waitForTimeout(1200);
      fullW = await page.$eval('#cvBefore', (c) => c.width);
      if (lows.length && Math.abs(lows[0][1] - Math.round(fullW / 5)) > 2) errors.push('baixa resolução diferente de 1/5');
      const res = await page.$eval('#cvBefore', (c) => c.dataset.res);
      if (res !== 'full') errors.push('render final não está em resolução completa');
      const yaw = await page.$eval('#yaw', (e) => +e.value);
      log('rotação: quadros em baixa resolução vistos =', lowSeen, '; largura final =', fullW, '; yaw =', yaw);
      if (!lowSeen) errors.push('rotação não usou baixa resolução');
      if (fullW < 300) errors.push('não voltou à resolução completa');
      await shot('05_viewer_girado');
      // arrastar no canvas
      const cb = await page.$eval('#cvAfter', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(cb.x, cb.y); await page.mouse.down(); await page.mouse.move(cb.x - 120, cb.y + 30, { steps: 8 }); await page.mouse.up();
      await page.waitForTimeout(1000);
    }
  }

  // download único
  const needApproval = s.jobs.some((j) => j.studies.some((x) => x.status === 'alert'));
  await page.click('#btnDlAll');
  if (needApproval || s.jobs.some((j) => j.studies.length)) {
    const dlgOpen = await page.waitForSelector('#dlgApprove[open]', { timeout: 3000 }).then(() => true).catch(() => false);
    if (dlgOpen) {
      await shot('06_aprovacao');
      // inclui todos os exames sem face (passagem sem alteração)
      const radios = await page.$$('#apList input[value=include]');
      for (const r of radios) await r.check();
      await page.click('#apGo');
    }
  }
  await page.waitForFunction(() => { const m = document.querySelector('#dlMsg'); return m && !m.classList.contains('hidden'); }, null, { timeout: 30 * 60 * 1000, polling: 500 });
  log('download:', await page.textContent('#dlMsg'));
  await shot('07_download');
  // copia o ZIP único do OPFS para o disco (em blocos)
  const where = args['no-dest'] ? 'saved' : 'picked-folder';
  const names = await page.evaluate(async (w) => { const r = await navigator.storage.getDirectory(); const d = await r.getDirectoryHandle(w); const out = []; for await (const [n] of d.entries()) out.push(n); return out; }, where);
  log('arquivos na pasta de destino:', names.join(', '));
  const lote = names.find((n) => n.startsWith('DEFACE_lote_'));
  if (lote) {
    const size = await page.evaluate(async ([w, n]) => { const r = await navigator.storage.getDirectory(); const f = await (await (await r.getDirectoryHandle(w)).getFileHandle(n)).getFile(); window.__lote = f; return f.size; }, [where, lote]);
    const fd = fs.openSync(path.join(outDir, 'lote.zip'), 'w');
    for (let off = 0; off < size; off += 8 << 20) {
      const b64 = await page.evaluate(async ([o]) => { const b = new Uint8Array(await window.__lote.slice(o, o + (8 << 20)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }, [off]);
      fs.writeSync(fd, Buffer.from(b64, 'base64'));
    }
    fs.closeSync(fd);
    log('lote.zip copiado:', size, 'bytes');
  } else errors.push('ZIP único não encontrado');
  const csv = names.find((n) => n.endsWith('.csv'));
  if (csv) {
    const txt = await page.evaluate(async ([w, n]) => { const r = await navigator.storage.getDirectory(); return (await (await (await r.getDirectoryHandle(w)).getFileHandle(n)).getFile()).text(); }, [where, csv]);
    fs.writeFileSync(path.join(outDir, 'correspondencia.csv'), txt);
  }
}

// auditoria de contraste e textos nos dois temas e idiomas
const audit = () => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let out = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a), a: 1 }; }
    return out;
  };
  const fails = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    if (el.closest('script,style,.sr,.hidden,dialog:not([open])')) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    const fg = parse(cs.color); const bg = bgOf(el);
    const fgc = { r: fg.r * fg.a * op + bg.r * (1 - fg.a * op), g: fg.g * fg.a * op + bg.g * (1 - fg.a * op), b: fg.b * fg.a * op + bg.b * (1 - fg.a * op) };
    const L1 = lum(fgc), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const disabled = !!el.closest(':disabled, [disabled]');
    const need = disabled ? 2.0 : (size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5);
    if (ratio < need) fails.push({ text: n.textContent.trim().slice(0, 50), ratio: +ratio.toFixed(2), need, cls: el.className });
  }
  // textos não traduzidos (chaves cruas)
  const raw = Array.from(document.querySelectorAll('[data-i18n]')).filter((e) => e.textContent.trim() === e.dataset.i18n);
  return { fails, raw: raw.map((e) => e.dataset.i18n) };
});
for (const th of ['dark', 'light']) for (const lg of ['pt', 'en']) {
  await page.click(`[data-theme-btn=${th}]`); await page.click(`[data-lang=${lg}]`);
  await page.waitForTimeout(500);
  const a = await audit();
  log(`contraste ${th}/${lg}: ${a.fails.length} falha(s); textos sem tradução: ${a.raw.length}`);
  for (const f of a.fails.slice(0, 15)) log('   ', JSON.stringify(f));
  if (a.fails.length) errors.push(`contraste ${th}/${lg}: ${a.fails.length}`);
  if (a.raw.length) errors.push(`tradução ${th}/${lg}: ${a.raw.join(',')}`);
  await shot(`10_${th}_${lg}`);
}
// tema automático segue o sistema
await page.click('[data-theme-btn=auto]');
await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(200);
const autoLight = await page.evaluate(() => document.documentElement.dataset.theme);
await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
const autoDark = await page.evaluate(() => document.documentElement.dataset.theme);
log('tema auto:', autoLight, autoDark);
if (autoLight !== 'light' || autoDark !== 'dark') errors.push('tema automático');
// largura de celular
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
log('estouro horizontal no celular:', overflow);
if (overflow > 1) errors.push('layout estoura no celular: ' + overflow);
await shot('11_mobile');

await browser.close();
await srv.close();
const filtered = errors;
fs.writeFileSync(path.join(outDir, 'errors.json'), JSON.stringify(filtered, null, 1));
log('ERROS:', filtered.length ? '\n' + filtered.join('\n') : 'nenhum');
process.exit(filtered.length ? 1 : 0);
