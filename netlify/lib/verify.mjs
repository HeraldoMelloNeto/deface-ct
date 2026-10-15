// Deface CT — verificação de e-mail por código (lógica compartilhada pelas funções Netlify).
// Só o e-mail e o código trafegam; nenhuma imagem passa por aqui.
import crypto from 'node:crypto';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CODE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_EMAIL = 5;   // por hora
const MAX_SENDS_IP = 20;     // por hora
const MAX_VERIFY_IP = 40;    // tentativas de verificação por IP e hora

// Erros previstos voltam com HTTP 200 e {ok:false, error, code} para não poluir o console do navegador
const json = (code, body) => new Response(JSON.stringify(code >= 400 && code !== 405 ? { ok: false, code, ...body } : body), {
  status: code === 405 ? 405 : 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
export function validEmail(e) { return e.length <= 254 && EMAIL_RE.test(e); }

export function mailerConfigured(env) {
  return !!(env.RESEND_API_KEY || (env.SMTP_USER && env.SMTP_PASS));
}
export function isConfigured(env) { return !!(env.CODE_SECRET && env.CODE_SECRET.length >= 16 && mailerConfigured(env)); }

function hmac(secret, s) { return crypto.createHmac('sha256', secret).update(s).digest('hex'); }

export function makeSession(secret, email, now) {
  const payload = b64u(JSON.stringify({ e: email, exp: now + SESSION_TTL }));
  return payload + '.' + hmac(secret, 'session:' + payload);
}
export function readSession(secret, token, now) {
  if (typeof token !== 'string' || token.length > 600 || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const exp = hmac(secret, 'session:' + payload);
  if (!sig || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || typeof o.e !== 'string' || !(o.exp > now)) return null;
    return o;
  } catch { return null; }
}

const TEXT = {
  pt: {
    subject: (c) => `Deface CT — código de verificação: ${c}`,
    body: (c) => `Seu código de verificação do Deface CT é: ${c}\n\nEle vale por 10 minutos. Se você não solicitou este código, ignore esta mensagem.\n\nO processamento das imagens no Deface CT ocorre 100% no seu navegador: nenhuma imagem ou arquivo DICOM é enviado a servidores.\n\nHMN Educação em Saúde · Dr. Heraldo O. Mello Neto`,
  },
  en: {
    subject: (c) => `Deface CT — verification code: ${c}`,
    body: (c) => `Your Deface CT verification code is: ${c}\n\nIt is valid for 10 minutes. If you did not request this code, please ignore this message.\n\nImage processing in Deface CT runs 100% in your browser: no image or DICOM file is ever sent to a server.\n\nHMN Educação em Saúde · Dr. Heraldo O. Mello Neto`,
  },
};

function html(text, code) {
  const esc = (s) => s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
  const parts = esc(text).split(code);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:520px">`
    + parts.join(`<strong style="font-size:26px;letter-spacing:4px;color:#0969da">${code}</strong>`).replace(/\n/g, '<br>') + `</div>`;
}

/** Envia o e-mail pelo provedor configurado (Resend ou SMTP). */
export async function defaultSendMail(env, { to, subject, text, htmlBody }) {
  const from = env.MAIL_FROM || env.SMTP_USER;
  if (env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html: htmlBody }),
    });
    if (!r.ok) throw new Error('resend ' + r.status);
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(env.SMTP_PORT || 465);
  const t = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await t.sendMail({ from, to, subject, text, html: htmlBody });
}

export function createHandlers({ store, env, sendMail = defaultSendMail, now = () => Date.now() }) {
  async function bump(key, limit) {
    const t = now();
    const r = (await store.get(key, { type: 'json' })) || { n: 0, w: t };
    if (t - r.w > 3600e3) { r.n = 0; r.w = t; }
    r.n++;
    await store.setJSON(key, r);
    return r.n <= limit;
  }

  async function sendCode(req, context) {
    if (req.method === 'GET') return json(200, { ok: true, configured: isConfigured(env), service: 'deface-ct' });
    if (req.method !== 'POST') return json(405, { error: 'method' });
    if (!isConfigured(env)) return json(503, { error: 'not_configured' });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
    const email = normalizeEmail(body && body.email);
    const lang = body && body.lang === 'en' ? 'en' : 'pt';
    if (!validEmail(email)) return json(400, { error: 'invalid_email' });
    if (!body.consent) return json(400, { error: 'consent' });
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'na';
    if (!(await bump('rate:ip:' + sha(ip), MAX_SENDS_IP))) return json(429, { error: 'rate' });
    if (!(await bump('rate:email:' + sha(email), MAX_SENDS_EMAIL))) return json(429, { error: 'rate' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await store.setJSON('code:' + sha(email), { h: hmac(env.CODE_SECRET, email + ':' + code), exp: now() + CODE_TTL, a: 0 });
    const tx = TEXT[lang];
    try {
      await sendMail(env, { to: email, subject: tx.subject(code), text: tx.body(code), htmlBody: html(tx.body(code), code) });
    } catch (e) {
      await store.delete('code:' + sha(email));
      return json(502, { error: 'send_failed' });
    }
    return json(200, { ok: true, expiresIn: CODE_TTL / 1000 });
  }

  async function verifyCode(req, context) {
    if (req.method !== 'POST') return json(405, { error: 'method' });
    if (!isConfigured(env)) return json(503, { error: 'not_configured' });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
    if (body && body.session) {
      const s = readSession(env.CODE_SECRET, body.session, now());
      return s ? json(200, { ok: true, email: s.e }) : json(401, { error: 'session' });
    }
    const email = normalizeEmail(body && body.email);
    const code = String((body && body.code) || '').replace(/\D/g, '');
    if (!validEmail(email) || code.length !== 6) return json(400, { error: 'invalid' });
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'na';
    if (!(await bump('vrate:ip:' + sha(ip), MAX_VERIFY_IP))) return json(429, { error: 'too_many' });
    const key = 'code:' + sha(email);
    const rec = await store.get(key, { type: 'json' });
    if (!rec || rec.exp < now()) { if (rec) await store.delete(key); return json(400, { error: 'expired' }); }
    if (rec.a >= MAX_ATTEMPTS) { await store.delete(key); return json(429, { error: 'too_many' }); }
    // conta a tentativa antes de comparar (limita tentativas em paralelo)
    rec.a++;
    await store.setJSON(key, rec);
    const exp = hmac(env.CODE_SECRET, email + ':' + code);
    const ok = typeof rec.h === 'string' && rec.h.length === exp.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(rec.h));
    if (!ok) {
      if (rec.a >= MAX_ATTEMPTS) await store.delete(key);
      return json(400, { error: 'invalid', remaining: Math.max(0, MAX_ATTEMPTS - rec.a) });
    }
    await store.delete(key);
    const ukey = 'user:' + sha(email);
    const u = (await store.get(ukey, { type: 'json' })) || { email, first: new Date(now()).toISOString(), n: 0 };
    u.last = new Date(now()).toISOString(); u.n++;
    await store.setJSON(ukey, u);
    return json(200, { ok: true, email, session: makeSession(env.CODE_SECRET, email, now()) });
  }

  return { sendCode, verifyCode };
}
