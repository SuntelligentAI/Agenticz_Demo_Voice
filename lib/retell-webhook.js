import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SIGNATURE_REGEX = /^v=(\d+),d=(.+)$/;

// Retell webhook signature header format:
//   `v=<unix_ms_timestamp>,d=<base64_hmac>`
// where the HMAC is SHA-256 over `rawBody + timestamp` with the webhook
// secret as the key. A ±5-minute timestamp window enforces replay protection.
export function verifyRetellSignature(
  rawBody,
  signature,
  secret,
  now = Date.now(),
) {
  if (typeof signature !== 'string' || !signature) return false;
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;

  const match = SIGNATURE_REGEX.exec(signature);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const digest = match[2];
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > FIVE_MINUTES_MS) return false;

  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  hmac.update(String(timestamp));
  const expected = hmac.digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(digest);
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Non-verifying inspector for diagnostic logging. Never touches the secret;
// only reports what shape the header has so we can tell malformed from
// "right shape, wrong secret".
export function describeRetellSignature(signature, { now = Date.now() } = {}) {
  if (typeof signature !== 'string' || !signature) {
    return { present: false };
  }
  const match = SIGNATURE_REGEX.exec(signature);
  if (!match) {
    return {
      present: true,
      length: signature.length,
      format: 'unrecognized',
    };
  }
  const timestamp = Number(match[1]);
  const digest = match[2];
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : null;
  return {
    present: true,
    length: signature.length,
    format: 'v=ts,d=digest',
    timestamp,
    ageMs,
    withinSkewWindow:
      typeof ageMs === 'number' && Math.abs(ageMs) <= FIVE_MINUTES_MS,
    digestLength: digest.length,
  };
}

// Map a Retell `call` payload to our internal `outcome` string.
// Order matters: `voicemail_reached` is more specific than hangup reasons.
export function mapOutcome(call) {
  const reason = call?.disconnection_reason;
  const status = call?.call_status;
  if (reason === 'voicemail_reached') return 'voicemail';
  if (reason === 'user_hangup' || reason === 'agent_hangup') return 'completed';
  if (status === 'no_answer') return 'no_answer';
  if (status === 'error' || status === 'failed') return 'failed';
  return 'completed';
}

function asMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

// Apply a verified webhook event to the DB. Never throws on "expected"
// problems (unknown call_id, duplicate event) — those return `ignored` so
// Retell doesn't retry.
export async function applyWebhookEvent({
  rawBody,
  event,
  call,
  receivedAt,
  db,
}) {
  if (!event || !call) {
    return { status: 200, body: { ok: true, ignored: 'bad_shape' } };
  }
  const retellCallId = call.call_id;
  if (!retellCallId) {
    return { status: 200, body: { ok: true, ignored: 'missing_call_id' } };
  }

  const lookup = await db.execute({
    sql: 'SELECT id, started_at FROM demo_calls WHERE retell_call_id = ?',
    args: [retellCallId],
  });
  const row = lookup.rows[0];
  if (!row) {
    console.warn(
      `[webhook] unknown retell_call_id event=${event} call_id=${retellCallId}`,
    );
    return { status: 200, body: { ok: true, ignored: 'call_not_found' } };
  }
  const demoCallId = row.id;

  // Dedup: identical (demo_call_id, event, raw payload) → skip insert and
  // skip status updates. Retries from Retell send byte-identical bodies.
  const dup = await db.execute({
    sql: `SELECT id FROM call_events
          WHERE demo_call_id = ? AND event_type = ? AND payload = ?
          LIMIT 1`,
    args: [demoCallId, event, rawBody],
  });
  if (dup.rows[0]) {
    return { status: 200, body: { ok: true, ignored: 'duplicate_event' } };
  }

  await db.execute({
    sql: `INSERT INTO call_events (id, demo_call_id, event_type, payload, received_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [randomUUID(), demoCallId, event, rawBody, receivedAt],
  });

  if (event === 'call_started') {
    const startedAt = asMs(call.start_timestamp) ?? receivedAt;
    await db.execute({
      sql: `UPDATE demo_calls
            SET status = 'in_progress', started_at = ?
            WHERE id = ?`,
      args: [startedAt, demoCallId],
    });
  } else if (event === 'call_ended') {
    const startTs = asMs(call.start_timestamp) ?? row.started_at ?? null;
    const endTs = asMs(call.end_timestamp) ?? receivedAt;
    const durationSeconds =
      startTs && endTs ? Math.max(0, Math.round((endTs - startTs) / 1000)) : null;
    await db.execute({
      sql: `UPDATE demo_calls
            SET status = 'ended', ended_at = ?, duration_seconds = ?, outcome = ?
            WHERE id = ?`,
      args: [endTs, durationSeconds, mapOutcome(call), demoCallId],
    });
  }
  // event === 'call_analyzed' → no status change (Phase 5 will populate transcript/summary).

  console.info(
    `[webhook] applied event=${event} call_id=${retellCallId} demo_call_id=${demoCallId}`,
  );
  return { status: 200, body: { ok: true } };
}
