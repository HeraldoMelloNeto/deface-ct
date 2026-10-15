// Testes da verificação de e-mail com armazenamento em memória e envio simulado
import assert from 'node:assert/strict';
import { createHandlers, readSession } from '../netlify/lib/verify.mjs';

class MemStore {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v === undefined ? null : JSON.parse(v); }
  async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); }
  async delete(k) { this.m.delete(k); }
}
const env = { CODE_SECRET: 'x'.repeat(32), SMTP_USER: 'a@b.com', SMTP_PASS: 'p' };
let t = 1_800_000_000_000;
const sent = [];
const store = new MemStore();
const H = createHandlers({ store, env, now: () => t, sendMail: async (e, m) => { sent.push(m); } });
const req = (method, body) => new Request('http://x/', { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const j = async (r) => { const body = await r.json(); return { status: body.code || r.status, body }; };

let r = await j(await H.sendCode(req('GET')));
assert.equal(r.body.configured, true);
r = await j(await H.sendCode(req('POST', { email: 'nao-email', consent: true })));
assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_email');
r = await j(await H.sendCode(req('POST', { email: 'Teste@Exemplo.com', consent: false })));
assert.equal(r.body.error, 'consent');
r = await j(await H.sendCode(req('POST', { email: 'Teste@Exemplo.com', consent: true, lang: 'pt' }), { ip: '1.2.3.4' }));
assert.equal(r.status, 200);
assert.equal(sent.length, 1);
const code = sent[0].subject.match(/(\d{6})/)[1];
assert.equal(sent[0].to, 'teste@exemplo.com');
assert.match(sent[0].text, /100% no seu navegador/);
// código errado
r = await j(await H.verifyCode(req('POST', { email: 'teste@exemplo.com', code: code === '000000' ? '111111' : '000000' })));
assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid'); assert.equal(r.body.remaining, 4);
// código certo
r = await j(await H.verifyCode(req('POST', { email: 'teste@exemplo.com', code })));
assert.equal(r.status, 200); assert.ok(r.body.session);
const sess = r.body.session;
assert.ok(readSession(env.CODE_SECRET, sess, t));
// reutilização do código falha
r = await j(await H.verifyCode(req('POST', { email: 'teste@exemplo.com', code })));
assert.equal(r.body.error, 'expired');
// sessão válida / adulterada
r = await j(await H.verifyCode(req('POST', { session: sess })));
assert.equal(r.status, 200); assert.equal(r.body.email, 'teste@exemplo.com');
r = await j(await H.verifyCode(req('POST', { session: sess.slice(0, -2) + 'aa' })));
assert.equal(r.status, 401);
// expiração do código
await H.sendCode(req('POST', { email: 'b@exemplo.com', consent: true }), { ip: '1.2.3.4' });
const code2 = sent[1].subject.match(/(\d{6})/)[1];
t += 11 * 60 * 1000;
r = await j(await H.verifyCode(req('POST', { email: 'b@exemplo.com', code: code2 })));
assert.equal(r.body.error, 'expired');
// limite de tentativas
await H.sendCode(req('POST', { email: 'c@exemplo.com', consent: true }), { ip: '1.2.3.4' });
const code3 = sent[2].subject.match(/(\d{6})/)[1];
const wrong = code3 === '123456' ? '654321' : '123456';
for (let i = 0; i < 4; i++) await H.verifyCode(req('POST', { email: 'c@exemplo.com', code: wrong }));
r = await j(await H.verifyCode(req('POST', { email: 'c@exemplo.com', code: wrong })));
assert.equal(r.body.remaining, 0);
r = await j(await H.verifyCode(req('POST', { email: 'c@exemplo.com', code: code3 })));
assert.equal(r.body.error, 'expired');
// limite de envios por e-mail (5/h)
for (let i = 0; i < 4; i++) await H.sendCode(req('POST', { email: 'd@exemplo.com', consent: true }), { ip: '9.9.9.' + i });
r = await j(await H.sendCode(req('POST', { email: 'd@exemplo.com', consent: true }), { ip: '9.9.9.9' }));
assert.equal(r.status, 200);
r = await j(await H.sendCode(req('POST', { email: 'd@exemplo.com', consent: true }), { ip: '9.9.9.8' }));
assert.equal(r.status, 429);
// falha de envio
const H2 = createHandlers({ store: new MemStore(), env, now: () => t, sendMail: async () => { throw new Error('x'); } });
r = await j(await H2.sendCode(req('POST', { email: 'e@exemplo.com', consent: true }), { ip: '1' }));
assert.equal(r.status, 502);
// sem configuração
// segredo automático (sem CODE_SECRET) também funciona
{
  const st2 = new MemStore(); const sent2 = [];
  const H4 = createHandlers({ store: st2, env: { SMTP_USER: 'a@b.com', SMTP_PASS: 'p' }, now: () => t, sendMail: async (e, m) => { sent2.push(m); } });
  await H4.sendCode(req('POST', { email: 'auto@exemplo.com', consent: true }), { ip: '5' });
  const c = sent2[0].subject.match(/(\d{6})/)[1];
  const r4 = await j(await H4.verifyCode(req('POST', { email: 'auto@exemplo.com', code: c })));
  assert.equal(r4.body.ok, true);
  const H5 = createHandlers({ store: st2, env: { SMTP_USER: 'a@b.com', SMTP_PASS: 'p' }, now: () => t });
  const r5 = await j(await H5.verifyCode(req('POST', { session: r4.body.session })));
  assert.equal(r5.body.ok, true, 'sessão válida após nova instância (segredo persistido)');
}
const H3 = createHandlers({ store: new MemStore(), env: {}, now: () => t });
r = await j(await H3.sendCode(req('GET')));
assert.equal(r.body.configured, false);
r = await j(await H3.sendCode(req('POST', { email: 'e@exemplo.com', consent: true })));
assert.equal(r.status, 503);
// usuário registrado
assert.ok([...store.m.keys()].some((k) => k.startsWith('user:')));
console.log('verify.test: todos os testes passaram');
