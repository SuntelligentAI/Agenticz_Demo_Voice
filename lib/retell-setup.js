// Helpers shared between the Retell setup scripts. Kept separate from
// lib/retell.js so unit tests can inject a fake getAgent without mocking
// the whole Retell client.

export const FALLBACK_VOICE_ID = '11labs-Adrian';

// Voice parity: the receptionist agent should sound identical to Speed To
// Lead. Resolution order:
//   1. RETELL_RECEPTIONIST_VOICE_ID override (for testing a different voice)
//   2. voice_id on the Speed To Lead agent (RETELL_AGENT_ID)
//   3. FALLBACK_VOICE_ID
export async function resolveReceptionistVoiceId({
  env = process.env,
  getAgent,
  log = console,
} = {}) {
  const forced = env.RETELL_RECEPTIONIST_VOICE_ID;
  if (typeof forced === 'string' && forced.trim()) {
    log.log?.(`Using RETELL_RECEPTIONIST_VOICE_ID override: ${forced.trim()}`);
    return forced.trim();
  }

  const sourceAgentId = env.RETELL_AGENT_ID;
  if (!sourceAgentId) {
    log.warn?.(
      `RETELL_AGENT_ID not set — using fallback voice ${FALLBACK_VOICE_ID}.`,
    );
    return FALLBACK_VOICE_ID;
  }
  if (typeof getAgent !== 'function') {
    log.warn?.('getAgent not provided; cannot read voice_id for parity.');
    return FALLBACK_VOICE_ID;
  }

  try {
    const sourceAgent = await getAgent(sourceAgentId);
    const voiceId = sourceAgent?.voice_id;
    if (typeof voiceId === 'string' && voiceId.trim()) {
      log.log?.(
        `Voice parity: using Speed To Lead voice_id=${voiceId} (from agent ${sourceAgentId}).`,
      );
      return voiceId.trim();
    }
    log.warn?.(
      `Speed To Lead agent ${sourceAgentId} has no voice_id; using fallback ${FALLBACK_VOICE_ID}.`,
    );
    return FALLBACK_VOICE_ID;
  } catch (err) {
    log.warn?.(
      `Could not fetch Speed To Lead agent ${sourceAgentId}: ${err?.message}. Using fallback ${FALLBACK_VOICE_ID}.`,
    );
    return FALLBACK_VOICE_ID;
  }
}
