import { getDb } from '../../lib/db.js';
import * as retellClient from '../../lib/retell.js';
import { getSessionUser } from '../../lib/auth.js';
import { performStartCall } from '../../lib/calls.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const fromNumber = process.env.RETELL_FROM_NUMBER;
  const overrideAgentId = process.env.RETELL_AGENT_ID;

  const result = await performStartCall({
    userId: user.id,
    input: req.body || {},
    db,
    retell: retellClient,
    fromNumber,
    overrideAgentId,
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res
    .status(200)
    .json({ id: result.id, retellCallId: result.retellCallId });
}
