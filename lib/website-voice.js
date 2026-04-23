import { randomUUID } from 'node:crypto';
import { START_CALL_RULES } from './validation.js';

// Same 15-min stage TTL as Receptionist.
export const STAGE_TTL_MS = 15 * 60 * 1000;

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

  await db.execute({
    sql: `UPDATE website_voice_stages
          SET cleared_at = ?
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?`,
    args: [now, userId, now],
  });

  const id = randomUUID();
  const expiresAt = now + STAGE_TTL_MS;
  await db.execute({
    sql: `INSERT INTO website_voice_stages (
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
    sql: `SELECT * FROM website_voice_stages
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
    sql: `SELECT id FROM website_voice_stages
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?
          LIMIT 1`,
    args: [userId, now],
  });
  if (!existing.rows[0]) {
    return { ok: true, cleared: 0 };
  }
  await db.execute({
    sql: `UPDATE website_voice_stages
          SET cleared_at = ?
          WHERE user_id = ? AND cleared_at IS NULL AND expires_at > ?`,
    args: [now, userId, now],
  });
  return { ok: true, cleared: 1 };
}

export function stageToDynamicVariables(stage) {
  return {
    agent_name: stage.agentName,
    company_name: stage.companyName,
    company_description: stage.companyDescription,
    call_purpose: stage.callPurpose,
  };
}
