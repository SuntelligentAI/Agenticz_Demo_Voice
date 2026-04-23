// Public, signature-verified endpoint. Retell calls this when an inbound
// call hits the receptionist agent; the response tells Retell which
// `{{dynamic_variable}}` values to splice into the prompt + begin message.
//
// Body parsing is disabled so we can HMAC-verify the raw request body.

import { randomUUID } from 'node:crypto';
import { getDb } from '../../lib/db.js';
import { verifyRetellSignature } from '../../lib/retell-webhook.js';
import {
  getMostRecentActiveStage,
  stageToDynamicVariables,
  getFallbackContext,
} from '../../lib/receptionist.js';
import { isReceptionistLineEnabled } from '../../lib/settings.js';
import { maybeAutoOffLine } from '../../lib/auto-off.js';

export const config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
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
    console.error('[receptionist-context] RETELL_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  let rawBody = '';
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const header = req.headers['x-retell-signature'];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature || !verifyRetellSignature(rawBody, signature, secret)) {
    console.log(
      '[receptionist-context] verify failed — returning 401',
      JSON.stringify({
        hasSignature: Boolean(signature),
        bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
      }),
    );
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // Malformed but signed — treat as empty payload; fallback context.
    payload = {};
  }

  const db = getDb();
  // Idle safety net: if the line has been on > 30 min with no stage
  // activity, flip it off right here before we decide what to serve.
  await maybeAutoOffLine({ db });
  const enabled = await isReceptionistLineEnabled(db);

  let source = 'fallback';
  let stage = null;
  if (enabled) {
    stage = await getMostRecentActiveStage({ db });
    if (stage) source = 'stage';
  }

  const variables = stage
    ? stageToDynamicVariables(stage)
    : getFallbackContext();

  // Log which context was served, for post-hoc linking. Does not need to be
  // tied to a demo_calls row (there isn't one yet at this moment) — we
  // persist it against a stable call_id if Retell provided one.
  const callId =
    payload?.call_inbound?.call_id ||
    payload?.call?.call_id ||
    payload?.call_id ||
    null;

  console.info(
    `[receptionist-context] served source=${source} enabled=${enabled} call_id=${callId || 'unknown'}`,
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    dynamic_variables: variables,
  });
}
