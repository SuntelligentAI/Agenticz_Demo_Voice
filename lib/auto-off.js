// Lazy "idle safety net" for kill-switch settings.
// Called on the hot read paths for each product (context webhook, stage
// endpoints, settings endpoint). If the line has been ON for more than the
// idle threshold AND no stage has been staged or cleared in that window,
// flip the line OFF with a machine reason so the UI can explain why.

import {
  RECEPTIONIST_LINE_ENABLED_KEY,
  WEBSITE_VOICE_ENABLED_KEY,
  WEB_CHAT_ENABLED_KEY,
  getSetting,
  setSetting,
} from './settings.js';

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export function getIdleThresholdMs() {
  const override = Number(process.env.RECEPTIONIST_IDLE_THRESHOLD_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_IDLE_THRESHOLD_MS;
}

// Hard-coded allow list so we don't accept arbitrary table names from
// callers — the SQL below interpolates the table name directly.
const ALLOWED_STAGE_TABLES = new Set([
  'receptionist_stages',
  'website_voice_stages',
  'web_chat_stages',
]);

async function maybeAutoOff({
  db,
  clock = () => Date.now(),
  settingKey,
  stagesTable,
  reasonTag = 'auto_off:idle_30min',
}) {
  if (!db) return { flipped: false, reason: null };
  if (!ALLOWED_STAGE_TABLES.has(stagesTable)) {
    throw new Error(`maybeAutoOff: unsupported stagesTable "${stagesTable}"`);
  }

  let enabled;
  try {
    const v = await getSetting(db, settingKey, 'false');
    enabled = v === 'true';
  } catch (err) {
    console.warn(`[auto-off:${settingKey}] could not read state:`, err?.message);
    return { flipped: false, reason: null };
  }
  if (!enabled) return { flipped: false, reason: null };

  const now = clock();
  const threshold = getIdleThresholdMs();
  const cutoff = now - threshold;

  let lineUpdatedAt = 0;
  try {
    const r = await db.execute({
      sql: 'SELECT updated_at FROM system_settings WHERE key = ?',
      args: [settingKey],
    });
    lineUpdatedAt = Number(r.rows[0]?.updated_at ?? 0);
  } catch (err) {
    console.warn(`[auto-off:${settingKey}] could not read updated_at:`, err?.message);
    return { flipped: false, reason: null };
  }

  // Turned on (or toggled off and back on) recently → still fresh.
  if (lineUpdatedAt >= cutoff) return { flipped: false, reason: null };

  let latestStaged = 0;
  let latestCleared = 0;
  try {
    const r = await db.execute({
      sql: `SELECT MAX(staged_at) AS latest_staged,
                   MAX(cleared_at) AS latest_cleared
            FROM ${stagesTable}`,
    });
    latestStaged = Number(r.rows[0]?.latest_staged ?? 0);
    latestCleared = Number(r.rows[0]?.latest_cleared ?? 0);
  } catch (err) {
    console.warn(`[auto-off:${settingKey}] could not read stage activity:`, err?.message);
    return { flipped: false, reason: null };
  }
  const latestActivity = Math.max(latestStaged, latestCleared);
  if (latestActivity >= cutoff) return { flipped: false, reason: null };

  // Idle past the threshold — flip it off.
  try {
    await setSetting(db, settingKey, 'false', 'system', reasonTag);
    console.info(
      `[auto-off:${settingKey}] flipped off — idle > ${Math.round(threshold / 60000)} min`,
    );
    return { flipped: true, reason: reasonTag };
  } catch (err) {
    console.warn(`[auto-off:${settingKey}] flip failed:`, err?.message);
    return { flipped: false, reason: null };
  }
}

// Product-specific variants. Preserve the existing receptionist API name
// so existing callers/tests don't need touching.
export async function maybeAutoOffLine(args = {}) {
  return maybeAutoOff({
    ...args,
    settingKey: RECEPTIONIST_LINE_ENABLED_KEY,
    stagesTable: 'receptionist_stages',
  });
}

export async function maybeAutoOffWebsiteVoiceLine(args = {}) {
  return maybeAutoOff({
    ...args,
    settingKey: WEBSITE_VOICE_ENABLED_KEY,
    stagesTable: 'website_voice_stages',
  });
}

export async function maybeAutoOffWebChatLine(args = {}) {
  return maybeAutoOff({
    ...args,
    settingKey: WEB_CHAT_ENABLED_KEY,
    stagesTable: 'web_chat_stages',
  });
}
