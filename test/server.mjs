// Servidor local de teste: serve index.html e simula as funções Netlify (com captura dos códigos enviados)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHandlers } from '../netlify/lib/verify.mjs';

export function startServer({ port = 8787, mode = 'functions', root = process.cwd() } = {}) {
  const mem = new Map();
  const store = {
    async get(k) { const v = mem.get(k); return v === undefined ? null : JSON.parse(v); },
    async setJSON(k, v) { mem.set(k, JSON.stringify(v)); },
    async delete(k) { mem.delete(k); },
  };
  const sent = [];
  const env = mode === 'unconfigured' ? {} : { CODE_SECRET: 'segredo-de-teste-123456789', SMTP_USER: 'x@y.z', SMTP_PASS: 'p' };
  const H = createHandlers({ store, env, sendMail: async (e, m) => { sent.push(m); } });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/.netlify/functions/')) {
        if (mode === 'none') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const r = new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
        const name = url.pathname.split('/').pop();
        const out = name === 'send-code' ? await H.sendCode(r, { ip: '127.0.0.1' }) : name === 'verify-code' ? await H.verifyCode(r) : new Response('nf', { status: 404 });
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const f = path.join(root, path.normalize(p));
      if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
      const hdr = { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' };
      if (mode !== 'none') hdr['x-deface-functions'] = '1';
      hdr['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
      res.writeHead(200, hdr);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(f).pipe(res);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, sent, close: () => new Promise((r) => server.close(r)) })));
}
