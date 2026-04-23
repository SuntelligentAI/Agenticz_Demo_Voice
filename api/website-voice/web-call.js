import { randomUUID } from 'node:crypto';
import { getDb } from '../../lib/db.js';
import { getSessionUser } from '../../lib/auth.js';
import {
  getActiveStageForUser,
  stageToDynamicVariables,
} from '../../lib/website-voice.js';
import { isWebsiteVoiceEnabled } from '../../lib/settings.js';
import { maybeAutoOffWebsiteVoiceLine } from '../../lib/auto-off.js';
import * as retellClient from '../../lib/retell.js';
import { redactPhone } from '../../lib/log.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const user = await getSessionUser(req, db);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Idle safety net — may flip the line off right now.
  await maybeAutoOffWebsiteVoiceLine({ db });

  const enabled = await isWebsiteVoiceEnabled(db);
  if (!enabled) {
    return res.status(503).json({ error: 'Line is off' });
  }

  const stage = await getActiveStageForUser({ userId: user.id, db });
  if (!stage) {
    return res.status(400).json({ error: 'No active stage' });
  }

  const agentId = process.env.RETELL_WEBSITE_VOICE_AGENT_ID;
  if (!agentId) {
    console.error('[web-call] RETELL_WEBSITE_VOICE_AGENT_ID is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const demoCallId = randomUUID();
  const now = Date.now();

  let retellResult;
  try {
    retellResult = await retellClient.createWebCall({
      agentId,
      metadata: {
        demo_call_id: demoCallId,
        user_id: user.id,
        product: 'website_voice_bot',
      },
      retellLlmDynamicVariables: stageToDynamicVariables(stage),
    });
  } catch (err) {
    console.error(
      `[web-call] retell error user=${user.id} demo_call_id=${demoCallId}: ${err?.message}`,
    );
    return res.status(502).json({ error: 'Could not start web call' });
  }

  // Persist the demo_calls row with product='website_voice_bot' so the
  // usual webhook lifecycle + dashboard history work unchanged. No prospect
  // phone on a web call — store '(web caller)' as a placeholder.
  await db.execute({
    sql: `INSERT INTO demo_calls (
            id, user_id, agent_name, company_name, company_description,
            call_purpose, prospect_name, prospect_phone,
            retell_call_id, status, product, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', 'website_voice_bot', ?)`,
    args: [
      demoCallId,
      user.id,
      stage.agentName,
      stage.companyName,
      stage.companyDescription,
      stage.callPurpose,
      '(web caller)',
      '(web)',
      retellResult.callId,
      now,
    ],
  });

  console.info(
    `[web-call] started demo_call=${demoCallId} retell_call=${retellResult.callId} user=${user.id}`,
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    callId: retellResult.callId,
    accessToken: retellResult.accessToken,
    demoCallId,
  });
}
