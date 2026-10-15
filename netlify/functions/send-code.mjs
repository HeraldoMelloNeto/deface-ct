// POST {email, lang, consent} -> envia código de 6 dígitos; GET -> estado do serviço
import { getStore } from '@netlify/blobs';
import { createHandlers } from '../lib/verify.mjs';

export default async (req, context) => {
  const store = getStore({ name: 'deface-ct-verify', consistency: 'strong' });
  const { sendCode } = createHandlers({ store, env: process.env });
  return sendCode(req, context);
};
