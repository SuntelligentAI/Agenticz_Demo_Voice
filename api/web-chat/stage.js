import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import {
  stageDemoForUser,
  getActiveStageForUser,
  clearStageForUser,
} from '../../lib/web-chat.js';
import { maybeAutoOffWebChatLine } from '../../lib/auto-off.js';

export default async function handler(req, res) {
  const method = req.method || 'GET';
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  await maybeAutoOffWebChatLine({ db });

  res.setHeader('Cache-Control', 'no-store');

  if (method === 'GET') {
    const stage = await getActiveStageForUser({ userId: user.id, db });
    return res.status(200).json({ stage });
  }

  if (method === 'POST') {
    const result = await stageDemoForUser({
      userId: user.id,
      input: req.body || {},
      db,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json({ stage: result.stage });
  }

  // DELETE
  const result = await clearStageForUser({ userId: user.id, db });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(200).json({ ok: true, cleared: result.cleared });
}
