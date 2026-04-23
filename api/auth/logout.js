import { getDb } from '../../lib/db.js';
import { buildClearCookie, getSessionUser } from '../../lib/auth.js';
import {
  setReceptionistLineEnabled,
  setWebsiteVoiceEnabled,
} from '../../lib/settings.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Best-effort: flip both shared lines OFF when someone logs out. Failures
  // here must not block the logout — the cookie still gets cleared.
  try {
    const db = getDb();
    const user = await getSessionUser(req, db);
    const actor = user?.email || 'unknown';
    await setReceptionistLineEnabled(db, false, actor, 'auto_off:logout');
    await setWebsiteVoiceEnabled(db, false, actor, 'auto_off:logout');
  } catch (err) {
    console.warn('[logout] auto-off failed:', err?.message);
  }

  res.setHeader('Set-Cookie', buildClearCookie());
  return res.status(200).json({ ok: true });
}
