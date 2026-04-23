import { randomUUID } from 'node:crypto';

// Thin wrapper over the system_settings key/value table. Values are stored as
// strings; callers decide how to interpret them. Every write also appends a
// row to system_settings_log so we can surface the last `reason` in the UI.

export const RECEPTIONIST_LINE_ENABLED_KEY = 'receptionist_line_enabled';
export const WEBSITE_VOICE_ENABLED_KEY = 'website_voice_enabled';

export async function getSetting(db, key, defaultValue = null) {
  const r = await db.execute({
    sql: 'SELECT value FROM system_settings WHERE key = ?',
    args: [key],
  });
  return r.rows[0]?.value ?? defaultValue;
}

export async function setSetting(db, key, value, updatedBy = null, reason = null) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO system_settings (key, value, updated_at, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
    args: [key, String(value), now, updatedBy],
  });
  await db.execute({
    sql: `INSERT INTO system_settings_log
          (id, key, value, updated_by, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), key, String(value), updatedBy, reason, now],
  });
  return { key, value: String(value), updatedAt: now, updatedBy, reason };
}

export async function getLatestLogEntry(db, key) {
  const r = await db.execute({
    sql: `SELECT value, updated_by, reason, created_at
          FROM system_settings_log
          WHERE key = ?
          ORDER BY created_at DESC
          LIMIT 1`,
    args: [key],
  });
  const row = r.rows[0];
  if (!row) return null;
  return {
    value: row.value,
    updatedBy: row.updated_by ?? null,
    reason: row.reason ?? null,
    createdAt: Number(row.created_at),
  };
}

export async function isReceptionistLineEnabled(db) {
  const v = await getSetting(db, RECEPTIONIST_LINE_ENABLED_KEY, 'false');
  return v === 'true';
}

export async function setReceptionistLineEnabled(
  db,
  enabled,
  updatedBy,
  reason = null,
) {
  return setSetting(
    db,
    RECEPTIONIST_LINE_ENABLED_KEY,
    enabled ? 'true' : 'false',
    updatedBy,
    reason,
  );
}

export async function isWebsiteVoiceEnabled(db) {
  const v = await getSetting(db, WEBSITE_VOICE_ENABLED_KEY, 'false');
  return v === 'true';
}

export async function setWebsiteVoiceEnabled(
  db,
  enabled,
  updatedBy,
  reason = null,
) {
  return setSetting(
    db,
    WEBSITE_VOICE_ENABLED_KEY,
    enabled ? 'true' : 'false',
    updatedBy,
    reason,
  );
}
