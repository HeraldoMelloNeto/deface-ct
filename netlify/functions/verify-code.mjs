// POST {email, code} -> valida e devolve sessão; POST {session} -> confere sessão
import { getStore } from '@netlify/blobs';
import { createHandlers } from '../lib/verify.mjs';

export default async (req, context) => {
  const store = getStore({ name: 'deface-ct-verify', consistency: 'strong' });
  const { verifyCode } = createHandlers({ store, env: process.env });
  return verifyCode(req, context);
};
