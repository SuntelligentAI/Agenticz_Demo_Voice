import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import {
  isReceptionistLineEnabled,
  setReceptionistLineEnabled,
  getLatestLogEntry,
  RECEPTIONIST_LINE_ENABLED_KEY,
} from '../../lib/settings.js';
import { maybeAutoOffLine } from '../../lib/auto-off.js';

// Parse the body defensively. Dashboard uses fetch with
// application/json (parsed by Vercel into an object). navigator.sendBeacon
// uses POST with text/plain by default, which arrives as a string — parse
// it as JSON. Fall back to an empty object on anything we can't read.
function parseBody(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  const method = req.method || 'GET';
  // Accept POST for navigator.sendBeacon (which only ever sends POST) as a
  // synonym for PUT — same write semantics.
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Lazy idle check — may flip the line off before we read its state.
  await maybeAutoOffLine({ db });

  const number = process.env.RETELL_RECEPTIONIST_NUMBER || null;
  res.setHeader('Cache-Control', 'no-store');

  if (method === 'GET') {
    const enabled = await isReceptionistLineEnabled(db);
    const lastLog = await getLatestLogEntry(db, RECEPTIONIST_LINE_ENABLED_KEY);
    return res.status(200).json({
      enabled,
      number,
      reason: lastLog?.reason ?? null,
      updatedBy: lastLog?.updatedBy ?? null,
      updatedAt: lastLog?.createdAt ?? null,
    });
  }

  // PUT or POST — write
  const body = parseBody(req.body);
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean' });
  }
  const incomingReason = typeof body.reason === 'string' ? body.reason : null;
  const reason =
    incomingReason || (body.enabled ? 'manual_on' : 'manual_off');

  const prev = await isReceptionistLineEnabled(db);
  await setReceptionistLineEnabled(db, body.enabled, user.email, reason);
  console.info(
    `[settings] receptionist_line_enabled ${prev} -> ${body.enabled} by ${user.email} (${reason})`,
  );
  return res.status(200).json({
    enabled: body.enabled,
    number,
    reason,
    updatedBy: user.email,
    updatedAt: Date.now(),
  });
}
