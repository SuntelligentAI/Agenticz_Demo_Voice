// This is the ONLY unauthenticated POST endpoint in the app.
// It is protected by HMAC-SHA256 signature verification against
// RETELL_WEBHOOK_SECRET. Requests without a valid signature are rejected
// with 401 before any parsing or DB work is performed.
//
// Body parsing is disabled so the raw body is available for HMAC verification
// — once JSON.parse has rewritten the bytes, the signature cannot be checked.

import { getDb } from '../../lib/db.js';
import {
  verifyRetellSignature,
  applyWebhookEvent,
} from '../../lib/retell-webhook.js';

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] RETELL_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const header = req.headers['x-retell-signature'];
  const signature = Array.isArray(header) ? header[0] : header;

  if (!signature || !verifyRetellSignature(rawBody, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const result = await applyWebhookEvent({
    rawBody,
    event: payload?.event,
    call: payload?.call,
    receivedAt: Date.now(),
    db: getDb(),
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(result.status).json(result.body);
}
