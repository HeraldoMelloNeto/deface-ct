// Pausar, retomar, cancelar (diálogo próprio), limpar e reprocessar — sem erros de console
import { createRequire } from 'node:module';
import { startServer } from './server.mjs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const srv = await startServer({ port: 8654, mode: 'none', root: process.cwd() });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/404/.test(m.text())) errs.push(m.text()); });
await p.goto('http://localhost:8654/');
await p.waitForFunction(() => window.DefaceCT.state.access === 'preview');
const S = () => p.evaluate(() => window.DefaceCT.state.jobs.map((j) => j.state + ':' + j.studies.map((s) => s.status).join(',')).join(' | '));
await p.setInputFiles('#fileInput', ['data/p1.zip', 'data/f7.zip', 'data/f8.zip', 'data/f9.zip']);
await p.click('#btnStart');
await p.waitForFunction(() => window.DefaceCT.state.jobs[0].state === 'done', null, { timeout: 120000 });
await p.click('#btnPause');
await p.waitForTimeout(300);
console.log('pausado:', await S());
await p.waitForFunction(() => !window.DefaceCT.state.jobs.some((j) => j.state === 'running'), null, { timeout: 120000 });
const afterPause = await S(); console.log('após terminar em andamento:', afterPause);
await p.click('#btnPause'); // retomar
await p.waitForFunction(() => window.DefaceCT.state.jobs.some((j) => j.state === 'running'), null, { timeout: 20000 });
await p.waitForTimeout(1500);
await p.click('#btnCancel');
await p.waitForSelector('#dlgConfirm[open]');
await p.click('#cfNo'); // desiste
console.log('cancelamento recusado; rodando:', await p.evaluate(() => window.DefaceCT.state.jobs.some((j) => j.state === 'running')));
await p.click('#btnCancel'); await p.waitForSelector('#dlgConfirm[open]'); await p.click('#cfYes');
await p.waitForTimeout(500);
console.log('cancelado:', await S());
const files = await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); const out = []; for await (const [n, h] of r.entries()) { if (h.kind === 'directory') { const d = await h.getDirectoryHandle('out').catch(() => null); if (d) for await (const [m] of d.entries()) out.push(n + '/' + m); } } return out; });
console.log('arquivos de saída no navegador:', files);
await p.click('#btnClear'); await p.waitForSelector('#dlgConfirm[open]'); await p.click('#cfYes');
await p.waitForTimeout(500);
console.log('após limpar:', JSON.stringify(await S()), 'tabela vazia visível:', await p.evaluate(() => !document.querySelector('#emptyBody').classList.contains('hidden')));
// novo lote depois de limpar
await p.setInputFiles('#fileInput', ['data/p1.zip']);
await p.click('#btnStart');
await p.waitForFunction(() => window.DefaceCT.state.jobs[0] && window.DefaceCT.state.jobs[0].state === 'done', null, { timeout: 120000 });
console.log('novo lote:', await S(), await p.evaluate(() => window.DefaceCT.state.jobs[0].studies[0].code));
console.log('erros:', errs);
await b.close(); await srv.close();
process.exit(errs.length ? 1 : 0);
