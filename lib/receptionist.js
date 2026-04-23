import { randomUUID } from 'node:crypto';
import { START_CALL_RULES } from './validation.js';

// A staged demo is valid for 15 minutes — long enough to walk the caller
// through the flow, short enough that abandoned stages don't silently linger.
export const STAGE_TTL_MS = 15 * 60 * 1000;

const FALLBACK_CONTEXT = Object.freeze({
  agent_name: 'the Agenticz demo line',
  company_name: 'the Agenticz demo line',
  company_description:
    'This is a demo line for Agenticz. No real business is on the other end right now.',
  call_purpose:
    "The caller has reached our demo line outside of a scheduled demonstration. Politely explain that the line is a demo, offer to point them to agenticz.io/book, and end the call warmly.",
});

export function getFallbackContext() {
  return { ...FALLBACK_CONTEXT };
}

// Same control-char / HTML / length rules as Speed To Lead — but only the
// four prompt fields, since there's no prospect name or phone for inbound.
const STAGE_FIELDS = [
  'agentName',
  'companyName',
  'companyDescription',
  'callPurpose',
];

function cleanString(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

export function validateStageInput(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid input', fieldErrors: {} };
  }
  const cleaned = {};
  for (const k of STAGE_FIELDS) cleaned[k] = cleanString(input[k]);

  const fieldErrors = {};
  for (const k of STAGE_FIELDS) {
    const rule = START_CALL_RULES[k];
    const v = cleaned[k];
    if (/[<>]/.test(v)) {
      fieldErrors[k] = `${rule.label} contains invalid characters.`;
      continue;
    }
    if (!v) {
      fieldErrors[k] = `${rule.label} is required.`;
      continue;
    }
    if (v.length < rule.min) {
      fieldErrors[k] = `${rule.label} must be at least ${rule.min} characters.`;
      continue;
    }
    if (v.length > rule.max) {
      fieldErrors[k] = `${rule.label} must be at most ${rule.max} characters.`;
      continue;
    }
    if (rule.pattern && !rule.pattern.test(v)) {
      fieldErrors[k] = `${rule.label} contains unsupported characters.`;
      continue;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Invalid input', fieldErrors };
  }
  return { ok: true, data: cleaned };
}

function rowToStage(row) {
  return {
    id: row.id,
    userId: row.user_id,
    agentName: row.agent_name,
    companyName: row.company_name,
    companyDescription: row.company_description,
    callPurpose: row.call_purpose,
    stagedAt: row.staged_at,
    expiresAt: row.expires_at,
    clearedAt: row.cleared_at,
  };
}

export async function stageDemoForUser({
  userId,
  input,
  db,
  clock = () => Date.now(),
}) {
  if (!userId) return { ok: false, status: 401, error: 'Unauthorized' };
  const validation = validateStageInput(input);
  if (!validation.ok) return { ok: false, status: 400, error: 'Invalid input' };

  const d = validation.data;
  const now = clock();

  // Clear any previous active stage for this user — one live stage per user.
  await db.execute({
    sql: `UPDATE receptionist_stages
          SET cleared_at = ?
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?`,
    args: [now, userId, now],
  });

  const id = randomUUID();
  const expiresAt = now + STAGE_TTL_MS;
  await db.execute({
    sql: `INSERT INTO receptionist_stages (
            id, user_id, agent_name, company_name, company_description,
            call_purpose, staged_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      userId,
      d.agentName,
      d.companyName,
      d.companyDescription,
      d.callPurpose,
      now,
      expiresAt,
    ],
  });

  return {
    ok: true,
    stage: {
      id,
      userId,
      agentName: d.agentName,
      companyName: d.companyName,
      companyDescription: d.companyDescription,
      callPurpose: d.callPurpose,
      stagedAt: now,
      expiresAt,
      clearedAt: null,
    },
  };
}

export async function getActiveStageForUser({
  userId,
  db,
  clock = () => Date.now(),
}) {
  if (!userId) return null;
  const now = clock();
  const r = await db.execute({
    sql: `SELECT * FROM receptionist_stages
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?
          ORDER BY staged_at DESC
          LIMIT 1`,
    args: [userId, now],
  });
  return r.rows[0] ? rowToStage(r.rows[0]) : null;
}

export async function clearStageForUser({
  userId,
  db,
  clock = () => Date.now(),
}) {
  if (!userId) return { ok: false, status: 401, error: 'Unauthorized' };
  const now = clock();
  const existing = await db.execute({
    sql: `SELECT id FROM receptionist_stages
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?
          LIMIT 1`,
    args: [userId, now],
  });
  if (!existing.rows[0]) {
    return { ok: true, cleared: 0 };
  }
  await db.execute({
    sql: `UPDATE receptionist_stages
          SET cleared_at = ?
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?`,
    args: [now, userId, now],
  });
  return { ok: true, cleared: 1 };
}

// Used by the public context webhook. Returns the single most-recent
// active stage across ALL users, because the receptionist number is shared.
export async function getMostRecentActiveStage({
  db,
  clock = () => Date.now(),
}) {
  const now = clock();
  const r = await db.execute({
    sql: `SELECT * FROM receptionist_stages
          WHERE cleared_at IS NULL AND expires_at > ?
          ORDER BY staged_at DESC
          LIMIT 1`,
    args: [now],
  });
  return r.rows[0] ? rowToStage(r.rows[0]) : null;
}

export function stageToDynamicVariables(stageOrNull) {
  if (!stageOrNull) return { ...FALLBACK_CONTEXT };
  return {
    agent_name: stageOrNull.agentName,
    company_name: stageOrNull.companyName,
    company_description: stageOrNull.companyDescription,
    call_purpose: stageOrNull.callPurpose,
  };
}
