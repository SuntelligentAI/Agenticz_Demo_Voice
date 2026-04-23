import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import {
  isReceptionistLineEnabled,
  setReceptionistLineEnabled,
} from '../../lib/settings.js';

export default async function handler(req, res) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  res.setHeader('Cache-Control', 'no-store');

  const number = process.env.RETELL_RECEPTIONIST_NUMBER || null;

  if (method === 'GET') {
    const enabled = await isReceptionistLineEnabled(db);
    return res.status(200).json({ enabled, number });
  }

  // PUT
  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: "`enabled` must be a boolean" });
  }
  const prev = await isReceptionistLineEnabled(db);
  await setReceptionistLineEnabled(db, body.enabled, user.email);
  console.info(
    `[settings] receptionist_line_enabled ${prev} -> ${body.enabled} by ${user.email}`,
  );
  return res.status(200).json({ enabled: body.enabled, number });
}
