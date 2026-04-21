import { getDb } from '../../../lib/db.js';
import { getSessionUser } from '../../../lib/auth.js';
import { updateCallNotes } from '../../../lib/calls.js';

export default async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const raw = req.query?.id;
  const callId =
    typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;

  const body = req.body || {};
  const result = await updateCallNotes({
    callId,
    userId: user.id,
    notes: body.notes,
    db,
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, notes: result.notes });
}
