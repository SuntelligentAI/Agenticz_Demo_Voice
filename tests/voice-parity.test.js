import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FALLBACK_VOICE_ID,
  resolveReceptionistVoiceId,
} from '../lib/retell-setup.js';

const silent = { log: () => {}, warn: () => {} };

describe('resolveReceptionistVoiceId', () => {
  it('uses the RETELL_RECEPTIONIST_VOICE_ID override when set', async () => {
    const getAgent = vi.fn();
    const v = await resolveReceptionistVoiceId({
      env: { RETELL_RECEPTIONIST_VOICE_ID: 'openai-Alloy' },
      getAgent,
      log: silent,
    });
    expect(v).toBe('openai-Alloy');
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('reads voice_id from the Speed To Lead agent when no override is set', async () => {
    const getAgent = vi.fn(async (id) => {
      expect(id).toBe('agent_stl_123');
      return { agent_id: id, voice_id: '11labs-Olivia' };
    });
    const v = await resolveReceptionistVoiceId({
      env: { RETELL_AGENT_ID: 'agent_stl_123' },
      getAgent,
      log: silent,
    });
    expect(v).toBe('11labs-Olivia');
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('falls back when RETELL_AGENT_ID is not set', async () => {
    const v = await resolveReceptionistVoiceId({
      env: {},
      getAgent: vi.fn(),
      log: silent,
    });
    expect(v).toBe(FALLBACK_VOICE_ID);
  });

  it('falls back when getAgent throws', async () => {
    const getAgent = vi.fn(async () => {
      throw new Error('404');
    });
    const v = await resolveReceptionistVoiceId({
      env: { RETELL_AGENT_ID: 'agent_stl_123' },
      getAgent,
      log: silent,
    });
    expect(v).toBe(FALLBACK_VOICE_ID);
  });

  it('falls back when agent has no voice_id field', async () => {
    const getAgent = vi.fn(async () => ({ agent_id: 'agent_stl_123' }));
    const v = await resolveReceptionistVoiceId({
      env: { RETELL_AGENT_ID: 'agent_stl_123' },
      getAgent,
      log: silent,
    });
    expect(v).toBe(FALLBACK_VOICE_ID);
  });
});
