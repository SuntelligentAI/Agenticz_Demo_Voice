import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import { getCallForUser } from '../../lib/calls.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const raw = req.query?.id;
  const callId =
    typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;

  const result = await getCallForUser({
    callId,
    userId: user.id,
    db,
  });

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result.data);
}
