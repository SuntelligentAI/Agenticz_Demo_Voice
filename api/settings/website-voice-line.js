import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import {
  isWebsiteVoiceEnabled,
  setWebsiteVoiceEnabled,
  getLatestLogEntry,
  WEBSITE_VOICE_ENABLED_KEY,
} from '../../lib/settings.js';
import { maybeAutoOffWebsiteVoiceLine } from '../../lib/auto-off.js';

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
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  await maybeAutoOffWebsiteVoiceLine({ db });

  res.setHeader('Cache-Control', 'no-store');

  if (method === 'GET') {
    const enabled = await isWebsiteVoiceEnabled(db);
    const lastLog = await getLatestLogEntry(db, WEBSITE_VOICE_ENABLED_KEY);
    return res.status(200).json({
      enabled,
      reason: lastLog?.reason ?? null,
      updatedBy: lastLog?.updatedBy ?? null,
      updatedAt: lastLog?.createdAt ?? null,
    });
  }

  // PUT or POST (sendBeacon)
  const body = parseBody(req.body);
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean' });
  }
  const incomingReason = typeof body.reason === 'string' ? body.reason : null;
  const reason =
    incomingReason || (body.enabled ? 'manual_on' : 'manual_off');

  const prev = await isWebsiteVoiceEnabled(db);
  await setWebsiteVoiceEnabled(db, body.enabled, user.email, reason);
  console.info(
    `[settings] website_voice_enabled ${prev} -> ${body.enabled} by ${user.email} (${reason})`,
  );
  return res.status(200).json({
    enabled: body.enabled,
    reason,
    updatedBy: user.email,
    updatedAt: Date.now(),
  });
}
