import { getDb } from '../../lib/db.js';
import { performLogin, getClientIp } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const result = await performLogin({
    email: body.email,
    password: body.password,
    ip: getClientIp(req),
    db: getDb(),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.setHeader('Set-Cookie', result.cookie);
  return res.status(200).json({ ok: true });
}
