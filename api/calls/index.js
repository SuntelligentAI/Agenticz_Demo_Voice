import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import { listCallsForUser } from '../../lib/calls.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const pageRaw = req.query?.page;
  const limitRaw = req.query?.limit;
  const page = Number(Array.isArray(pageRaw) ? pageRaw[0] : pageRaw) || 1;
  const limit = Number(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw) || 20;

  const result = await listCallsForUser({
    userId: user.id,
    page,
    limit,
    db,
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result.data);
}
