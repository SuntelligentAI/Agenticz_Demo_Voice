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
  describeRetellSignature,
  diagnoseHmacInputs,
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

function isSignatureHeaderName(name) {
  const n = String(name).toLowerCase();
  return (
    n.includes('signature') ||
    n.includes('retell') ||
    n === 'x-sig' ||
    n === 'sig'
  );
}

function collectSignatureHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (isSignatureHeaderName(k)) out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RETELL_WEBHOOK_SECRET;

  let rawBody = '';
  try {
    rawBody = await getRawBody(req);
  } catch {
    console.log(
      '[retell-webhook] failed to read raw body',
      JSON.stringify({ method: req.method, url: req.url }),
    );
    return res.status(400).json({ error: 'Invalid request' });
  }

  // --- Diagnostic block — runs before signature verification ---------------
  // Logs metadata only (header names, byte lengths). Never logs the webhook
  // secret, the Turso token, or the JWT secret. Signature-related headers are
  // logged in full because they arrive from the public request and are
  // useless without the secret.
  console.log(
    '[retell-webhook] request received',
    JSON.stringify({
      method: req.method,
      url: req.url,
      headerNames: Object.keys(req.headers),
      signatureHeaders: collectSignatureHeaders(req.headers),
      rawBodyBytes: Buffer.byteLength(rawBody, 'utf8'),
      secretSet: Boolean(secret),
      secretByteLength: secret ? Buffer.byteLength(secret, 'utf8') : 0,
    }),
  );
  // -------------------------------------------------------------------------

  if (!secret) {
    console.error('[retell-webhook] RETELL_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const HEADER_NAME = 'x-retell-signature';
  const headerValue = req.headers[HEADER_NAME];
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!signature) {
    console.log(
      '[retell-webhook] verify failed: missing signature header',
      JSON.stringify({
        headerNameChecked: HEADER_NAME,
        headerNamesPresent: Object.keys(req.headers),
      }),
    );
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (!verifyRetellSignature(rawBody, signature, secret)) {
    const sigShape = describeRetellSignature(signature);
    const reason = !sigShape.present
      ? 'signature missing'
      : sigShape.format === 'unrecognized'
        ? 'signature header format unrecognized (expected v=<ts>,d=<digest>)'
        : !sigShape.withinSkewWindow
          ? 'timestamp outside 5-minute skew window (replay protection)'
          : 'hmac mismatch (likely wrong secret or altered body)';

    console.log(
      '[retell-webhook] verify failed: ' + reason,
      JSON.stringify({
        headerName: HEADER_NAME,
        signatureReceived: signature,
        signatureShape: sigShape,
        rawBodyBytes: Buffer.byteLength(rawBody, 'utf8'),
      }),
    );

    console.log(
      '[retell-webhook] hmac inputs',
      JSON.stringify(diagnoseHmacInputs(rawBody, signature, secret)),
    );

    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.log('[retell-webhook] invalid JSON after successful signature verify');
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
