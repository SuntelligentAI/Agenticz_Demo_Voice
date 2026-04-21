import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SIGNATURE_REGEX = /^v=(\d+),d=(.+)$/;

// Retell webhook signature header format:
//   `v=<unix_ms_timestamp>,d=<hex_hmac>`
// where the HMAC is SHA-256 over `rawBody + String(timestamp)` using the
// Retell API key as the HMAC secret. A ±5-minute timestamp window enforces
// replay protection.
export function verifyRetellSignature(
  rawBody,
  signature,
  secret,
  now = Date.now(),
) {
  if (!signature || !secret) return false;
  if (typeof signature !== 'string') return false;
  if (typeof secret !== 'string') return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;

  const match = SIGNATURE_REGEX.exec(signature);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const received = match[2];
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > FIVE_MINUTES_MS) return false;

  const expected = createHmac('sha256', secret)
    .update(rawBody + String(timestamp))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Diagnostic: dump the exact inputs the HMAC is being computed over, so we
// can compare against what another client (e.g. LeadSafe) produces. NEVER
// logs the full secret — only first/last 4 chars and byte length. Also
// never logs the full computed digest — only first 16 hex chars.
export function diagnoseHmacInputs(
  rawBody,
  signature,
  secret,
  { now = Date.now() } = {},
) {
  const rawBodyStr = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : typeof rawBody === 'string'
      ? rawBody
      : '';

  let timestamp = null;
  let receivedDigest = null;
  if (typeof signature === 'string' && signature) {
    const match = SIGNATURE_REGEX.exec(signature);
    if (match) {
      timestamp = Number(match[1]);
      receivedDigest = match[2];
    }
  }

  const hmacInput =
    rawBodyStr + (timestamp !== null && Number.isFinite(timestamp) ? String(timestamp) : '');

  let computedDigestHex = null;
  if (
    typeof secret === 'string' &&
    secret &&
    timestamp !== null &&
    Number.isFinite(timestamp) &&
    (typeof rawBody === 'string' || Buffer.isBuffer(rawBody))
  ) {
    // Mirror the verifier: single update, rawBody + String(timestamp), hex digest.
    computedDigestHex = createHmac('sha256', secret)
      .update(rawBody + String(timestamp))
      .digest('hex');
  }

  // Received digest arrives in hex form from Retell — no decode needed.
  const receivedDigestHex =
    typeof receivedDigest === 'string' && receivedDigest ? receivedDigest : null;

  return {
    secretFirst4: typeof secret === 'string' ? secret.slice(0, 4) : null,
    secretLast4: typeof secret === 'string' ? secret.slice(-4) : null,
    secretByteLength:
      typeof secret === 'string' ? Buffer.byteLength(secret, 'utf8') : 0,
    hmacInputPreview: hmacInput.slice(0, 80),
    hmacInputLength: Buffer.byteLength(hmacInput, 'utf8'),
    timestampUsed: timestamp,
    computedDigestFirst16: computedDigestHex
      ? computedDigestHex.slice(0, 16)
      : null,
    computedDigestLength: computedDigestHex ? computedDigestHex.length : 0,
    receivedDigestFirst16: receivedDigestHex
      ? receivedDigestHex.slice(0, 16)
      : null,
    receivedDigestLength: receivedDigestHex ? receivedDigestHex.length : 0,
    nowUsed: now,
  };
}

// Diagnostic: compute HMAC-SHA256 (hex, first 16 chars) over each of several
// plausible "body + timestamp" orderings so we can see at a glance which one
// (if any) matches the digest Retell sent. Pure read-only; never mutates the
// verifier or its inputs.
export function tryHmacOrderings(rawBody, signature, secret) {
  let timestamp = null;
  let received = null;
  if (typeof signature === 'string' && signature) {
    const m = SIGNATURE_REGEX.exec(signature);
    if (m) {
      timestamp = Number(m[1]);
      received = m[2];
    }
  }

  const out = {
    received: typeof received === 'string' ? received.slice(0, 16) : null,
    A_body_plus_ts: null,
    B_ts_plus_body: null,
    C_ts_dot_body: null,
    D_body_dot_ts: null,
    E_body_only: null,
  };

  if (typeof secret !== 'string' || !secret) return out;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return out;

  const bodyStr = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : rawBody;
  const compute = (input) =>
    createHmac('sha256', secret).update(input).digest('hex').slice(0, 16);

  out.E_body_only = compute(bodyStr);

  if (timestamp !== null && Number.isFinite(timestamp)) {
    const ts = String(timestamp);
    out.A_body_plus_ts = compute(bodyStr + ts);
    out.B_ts_plus_body = compute(ts + bodyStr);
    out.C_ts_dot_body = compute(ts + '.' + bodyStr);
    out.D_body_dot_ts = compute(bodyStr + '.' + ts);
  }

  return out;
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

// Best-effort structured extraction from Retell's `call_analysis` object.
// Only uses explicit fields — never infers data we don't have. Returns an
// object with the three standard keys (any of which may be null) plus any
// scalar fields Retell already provided (user_sentiment, call_successful).
export function extractCapturedFields(call) {
  const analysis = call?.call_analysis;
  if (!analysis || typeof analysis !== 'object') return null;

  const fields = {
    interestedInFollowUp: null,
    proposedSlot: null,
    qualifyingNotes: null,
  };

  const custom =
    analysis.custom_analysis_data &&
    typeof analysis.custom_analysis_data === 'object'
      ? analysis.custom_analysis_data
      : null;

  const pick = (obj, ...keys) => {
    for (const k of keys) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
    }
    return undefined;
  };

  const interested = pick(
    custom,
    'interested_in_follow_up',
    'interestedInFollowUp',
  );
  if (typeof interested === 'boolean') {
    fields.interestedInFollowUp = interested;
  }

  const slot = pick(custom, 'proposed_slot', 'proposedSlot');
  if (typeof slot === 'string' && slot.trim()) {
    fields.proposedSlot = slot.trim();
  }

  const qn = pick(custom, 'qualifying_notes', 'qualifyingNotes');
  if (typeof qn === 'string' && qn.trim()) {
    fields.qualifyingNotes = qn.trim();
  }

  if (typeof analysis.user_sentiment === 'string') {
    fields.userSentiment = analysis.user_sentiment;
  }
  if (typeof analysis.call_successful === 'boolean') {
    fields.callSuccessful = analysis.call_successful;
  }

  return fields;
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
  } else if (event === 'call_analyzed') {
    // Persist the analyzed artefacts. Do NOT touch status — call_ended already
    // set it to 'ended'. Idempotency of replays is covered by the payload-hash
    // dedup above (this branch only runs for never-seen payloads).
    const transcript =
      typeof call.transcript === 'string' ? call.transcript : null;
    const recordingUrl =
      typeof call.recording_url === 'string' ? call.recording_url : null;
    const aiSummary =
      typeof call?.call_analysis?.call_summary === 'string'
        ? call.call_analysis.call_summary
        : null;
    const captured = extractCapturedFields(call);
    const capturedFieldsJson = captured ? JSON.stringify(captured) : null;

    await db.execute({
      sql: `UPDATE demo_calls
            SET transcript = ?, recording_url = ?, ai_summary = ?, captured_fields = ?
            WHERE id = ?`,
      args: [transcript, recordingUrl, aiSummary, capturedFieldsJson, demoCallId],
    });
  }

  console.info(
    `[webhook] applied event=${event} call_id=${retellCallId} demo_call_id=${demoCallId}`,
  );
  return { status: 200, body: { ok: true } };
}
