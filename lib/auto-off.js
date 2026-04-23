// Lazy "idle safety net" for the receptionist kill switch.
// Called on the hot read paths (context webhook, stage GET, settings GET).
// If the line has been ON for more than the idle threshold AND no stage has
// been staged or cleared in that window, flip the line OFF with a machine
// reason so the UI can explain why it happened.

import {
  RECEPTIONIST_LINE_ENABLED_KEY,
  isReceptionistLineEnabled,
  setReceptionistLineEnabled,
} from './settings.js';

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export function getIdleThresholdMs() {
  const override = Number(process.env.RECEPTIONIST_IDLE_THRESHOLD_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_IDLE_THRESHOLD_MS;
}

// Returns { flipped: boolean, reason: string|null }.
// Never throws on "expected" conditions — logs + returns not-flipped.
export async function maybeAutoOffLine({ db, clock = () => Date.now() } = {}) {
  if (!db) return { flipped: false, reason: null };

  let enabled;
  try {
    enabled = await isReceptionistLineEnabled(db);
  } catch (err) {
    console.warn('[auto-off] could not read line state:', err?.message);
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
      args: [RECEPTIONIST_LINE_ENABLED_KEY],
    });
    lineUpdatedAt = Number(r.rows[0]?.updated_at ?? 0);
  } catch (err) {
    console.warn('[auto-off] could not read updated_at:', err?.message);
    return { flipped: false, reason: null };
  }

  // Line turned on (or toggled off and back on) recently → still fresh.
  if (lineUpdatedAt >= cutoff) return { flipped: false, reason: null };

  let latestStaged = 0;
  let latestCleared = 0;
  try {
    const r = await db.execute({
      sql: `SELECT MAX(staged_at) AS latest_staged,
                   MAX(cleared_at) AS latest_cleared
            FROM receptionist_stages`,
    });
    latestStaged = Number(r.rows[0]?.latest_staged ?? 0);
    latestCleared = Number(r.rows[0]?.latest_cleared ?? 0);
  } catch (err) {
    console.warn('[auto-off] could not read stage activity:', err?.message);
    return { flipped: false, reason: null };
  }
  const latestActivity = Math.max(latestStaged, latestCleared);
  if (latestActivity >= cutoff) return { flipped: false, reason: null };

  // Idle past the threshold — flip it off.
  try {
    await setReceptionistLineEnabled(
      db,
      false,
      'system',
      'auto_off:idle_30min',
    );
    console.info(
      `[auto-off] flipped line off — idle > ${Math.round(threshold / 60000)} min`,
    );
    return { flipped: true, reason: 'auto_off:idle_30min' };
  } catch (err) {
    console.warn('[auto-off] flip failed:', err?.message);
    return { flipped: false, reason: null };
  }
}
