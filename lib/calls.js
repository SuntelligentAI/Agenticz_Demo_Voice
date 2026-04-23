import { randomUUID } from 'node:crypto';
import { createRateLimiter } from './rate-limit.js';
import { validateStartCallInput } from './validation.js';
import { redactPhone } from './log.js';

// TODO: Replace in-memory limiter with Upstash Redis in Phase 6 hardening.
const callLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
});

const notesLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
});

export function _resetCallRateLimiter() {
  callLimiter.reset();
}

export function _resetNotesRateLimiter() {
  notesLimiter.reset();
}

export function _callRateLimiterSize() {
  return callLimiter.size();
}

// Public projection of a demo_calls row. Omits user_id (internal) and the
// prompt inputs (company_description, call_purpose). Phase 5 includes the
// post-call artefacts: transcript, recording_url, ai_summary, captured_fields
// (parsed from JSON), notes.
function rowToPublicCamel(row) {
  let capturedFields = null;
  if (typeof row.captured_fields === 'string' && row.captured_fields) {
    try {
      capturedFields = JSON.parse(row.captured_fields);
    } catch {
      capturedFields = null;
    }
  }
  return {
    id: row.id,
    product: row.product ?? 'speed_to_lead',
    status: row.status,
    outcome: row.outcome,
    agentName: row.agent_name,
    companyName: row.company_name,
    prospectName: row.prospect_name,
    prospectPhone: row.prospect_phone,
    retellCallId: row.retell_call_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    transcript: row.transcript ?? null,
    recordingUrl: row.recording_url ?? null,
    aiSummary: row.ai_summary ?? null,
    capturedFields,
    notes: row.notes ?? null,
  };
}

// Slimmer projection for the history list — omits transcript / recording /
// summary / captured fields / notes to keep the response small.
function rowToListCamel(row) {
  return {
    id: row.id,
    product: row.product ?? 'speed_to_lead',
    status: row.status,
    outcome: row.outcome,
    agentName: row.agent_name,
    companyName: row.company_name,
    prospectName: row.prospect_name,
    prospectPhone: row.prospect_phone,
    retellCallId: row.retell_call_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
  };
}

const ALLOWED_PRODUCTS = new Set([
  'speed_to_lead',
  'receptionist',
  'website_voice_bot',
]);

export async function performStartCall({
  userId,
  input,
  db,
  retell,
  fromNumber,
  overrideAgentId,
  clock = () => Date.now(),
}) {
  if (!userId) {
    return { ok: false, status: 500, error: 'Missing user context' };
  }
  if (!fromNumber || !overrideAgentId) {
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  const now = clock();

  const rate = callLimiter.check(userId, now);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many call attempts, please wait a few minutes.',
    };
  }

  const validation = validateStartCallInput(input);
  if (!validation.ok) {
    return { ok: false, status: 400, error: 'Invalid input' };
  }
  const data = validation.data;

  // Reserve a slot only once validation passes — garbage input doesn't eat budget.
  callLimiter.record(userId, now);

  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO demo_calls (
      id, user_id, agent_name, company_name, company_description,
      call_purpose, prospect_name, prospect_phone, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [
      id,
      userId,
      data.agentName,
      data.companyName,
      data.companyDescription,
      data.callPurpose,
      data.prospectName,
      data.prospectPhone,
      now,
    ],
  });

  try {
    const { callId: retellCallId } = await retell.createPhoneCall({
      fromNumber,
      toNumber: data.prospectPhone,
      overrideAgentId,
      metadata: { demo_call_id: id, user_id: userId },
      retellLlmDynamicVariables: {
        agent_name: data.agentName,
        company_name: data.companyName,
        company_description: data.companyDescription,
        call_purpose: data.callPurpose,
        prospect_name: data.prospectName,
      },
    });

    await db.execute({
      sql: `UPDATE demo_calls
            SET retell_call_id = ?, status = 'dialing'
            WHERE id = ?`,
      args: [retellCallId, id],
    });

    return { ok: true, id, retellCallId };
  } catch (err) {
    console.error(
      `[calls.start] retell error user=${userId} demo_call_id=${id} phone=${redactPhone(
        data.prospectPhone,
      )}: ${err?.message || 'unknown error'}`,
    );
    await db.execute({
      sql: `UPDATE demo_calls
            SET status = 'failed', outcome = 'trigger_error'
            WHERE id = ?`,
      args: [id],
    });
    return { ok: false, status: 502, error: 'Could not place call' };
  }
}

export async function getCallForUser({ callId, userId, db }) {
  if (!callId || typeof callId !== 'string') {
    return { ok: false, status: 404, error: 'Not found' };
  }
  if (!userId) {
    return { ok: false, status: 404, error: 'Not found' };
  }

  const result = await db.execute({
    sql: 'SELECT * FROM demo_calls WHERE id = ? AND user_id = ?',
    args: [callId, userId],
  });
  const row = result.rows[0];
  if (!row) return { ok: false, status: 404, error: 'Not found' };
  return { ok: true, data: rowToPublicCamel(row) };
}

export async function listCallsForUser({
  userId,
  page = 1,
  limit = 20,
  product = null,
  db,
}) {
  if (!userId) {
    return {
      ok: true,
      data: {
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1,
      },
    };
  }
  const safeLimit = Math.min(
    Math.max(1, Number.isFinite(+limit) ? Math.floor(+limit) : 20),
    50,
  );
  const safePage = Math.max(
    1,
    Number.isFinite(+page) ? Math.floor(+page) : 1,
  );
  const offset = (safePage - 1) * safeLimit;

  const productFilter =
    typeof product === 'string' && ALLOWED_PRODUCTS.has(product)
      ? product
      : null;

  const whereSql = productFilter
    ? 'WHERE user_id = ? AND product = ?'
    : 'WHERE user_id = ?';
  const whereArgs = productFilter ? [userId, productFilter] : [userId];

  const countResult = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM demo_calls ${whereSql}`,
    args: whereArgs,
  });
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await db.execute({
    sql: `SELECT id, product, status, outcome, agent_name, company_name,
                 prospect_name, prospect_phone, retell_call_id,
                 created_at, started_at, ended_at, duration_seconds
          FROM demo_calls
          ${whereSql}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
    args: [...whereArgs, safeLimit, offset],
  });

  return {
    ok: true,
    data: {
      items: result.rows.map(rowToListCamel),
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      product: productFilter,
    },
  };
}

const NOTES_MAX_LENGTH = 5000;
// Strip control chars except newline (\n), carriage return (\r), tab (\t).
const NOTES_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function cleanNotes(value) {
  if (typeof value !== 'string') return null;
  return value.replace(NOTES_CONTROL_CHARS, '');
}

export async function updateCallNotes({
  callId,
  userId,
  notes,
  db,
  clock = () => Date.now(),
}) {
  if (!userId) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (!callId || typeof callId !== 'string') {
    return { ok: false, status: 404, error: 'Not found' };
  }

  const now = clock();
  const rate = notesLimiter.check(userId, now);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many note updates, please slow down.',
    };
  }

  const cleaned = cleanNotes(notes);
  if (cleaned === null) {
    return { ok: false, status: 400, error: 'Invalid notes' };
  }
  if (cleaned.length > NOTES_MAX_LENGTH) {
    return { ok: false, status: 400, error: 'Notes too long' };
  }
  if (/[<>]/.test(cleaned)) {
    return {
      ok: false,
      status: 400,
      error: 'Notes contain invalid characters',
    };
  }

  // Budget is consumed once we've got validated input — prevents a spammy
  // client from exhausting the budget with malformed payloads.
  notesLimiter.record(userId, now);

  // SELECT first so we can return 404 cleanly on foreign rows without having
  // to rely on rowsAffected (which not every fake DB surfaces the same way).
  const existing = await db.execute({
    sql: 'SELECT id FROM demo_calls WHERE id = ? AND user_id = ?',
    args: [callId, userId],
  });
  if (!existing.rows[0]) {
    return { ok: false, status: 404, error: 'Not found' };
  }

  await db.execute({
    sql: 'UPDATE demo_calls SET notes = ? WHERE id = ?',
    args: [cleaned, callId],
  });

  return { ok: true, notes: cleaned };
}
