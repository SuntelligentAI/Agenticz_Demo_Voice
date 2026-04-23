// Thin wrapper over the system_settings key/value table. Values are stored as
// strings; callers decide how to interpret them.

export const RECEPTIONIST_LINE_ENABLED_KEY = 'receptionist_line_enabled';

export async function getSetting(db, key, defaultValue = null) {
  const r = await db.execute({
    sql: 'SELECT value FROM system_settings WHERE key = ?',
    args: [key],
  });
  return r.rows[0]?.value ?? defaultValue;
}

export async function setSetting(db, key, value, updatedBy = null) {
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
  return { key, value: String(value), updatedAt: now };
}

export async function isReceptionistLineEnabled(db) {
  const v = await getSetting(db, RECEPTIONIST_LINE_ENABLED_KEY, 'false');
  return v === 'true';
}

export async function setReceptionistLineEnabled(db, enabled, updatedBy) {
  return setSetting(
    db,
    RECEPTIONIST_LINE_ENABLED_KEY,
    enabled ? 'true' : 'false',
    updatedBy,
  );
}
