import { randomUUID } from 'node:crypto';
import { createRateLimiter } from './rate-limit.js';
import { validateStartCallInput } from './validation.js';
import { redactPhone } from './log.js';

// TODO: Replace in-memory limiter with Upstash Redis in Phase 6 hardening.
const callLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
});

export function _resetCallRateLimiter() {
  callLimiter.reset();
}

export function _callRateLimiterSize() {
  return callLimiter.size();
}

// Public projection of a demo_calls row. Omits user_id (internal),
// company_description / call_purpose (prompt inputs, not call state),
// and transcript/recording/summary/notes (Phase 5 will render those).
function rowToPublicCamel(row) {
  return {
    id: row.id,
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
