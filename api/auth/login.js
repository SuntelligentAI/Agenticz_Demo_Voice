import { getDb } from '../../lib/db.js';
import {
  performLogin,
  getClientIp,
  sanitizeNext,
} from '../../lib/auth.js';

function wantsJson(req) {
  const accept = req.headers?.accept || '';
  // If the client explicitly prefers JSON, return JSON. Otherwise (form POST,
  // curl, etc.) default to 302 so the flow works without JavaScript.
  return /application\/json/i.test(accept);
}

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

  const useJson = wantsJson(req);

  if (!result.ok) {
    if (useJson) {
      return res.status(result.status).json({ error: result.error });
    }
    // Traditional form path: send the browser back to /login, preserving
    // `next` so the user can retry without losing their destination.
    const next = typeof body.next === 'string' ? body.next : '';
    const loginUrl = next
      ? `/login?error=1&next=${encodeURIComponent(next)}`
      : '/login?error=1';
    res.setHeader('Location', loginUrl);
    return res.status(302).end();
  }

  res.setHeader('Set-Cookie', result.cookie);
  const redirectTo = sanitizeNext(body.next);

  if (useJson) {
    return res.status(200).json({ ok: true, next: redirectTo });
  }
  res.setHeader('Location', redirectTo);
  return res.status(302).end();
}
