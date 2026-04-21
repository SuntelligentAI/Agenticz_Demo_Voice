import { getSessionFromReq } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromReq(req);
  if (!session || typeof session.email !== 'string') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ email: session.email });
}
