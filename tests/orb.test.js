import { describe, it, expect } from 'vitest';
import { ORB_STATES, orbStateFromEvent } from '../lib/orb.js';

describe('orbStateFromEvent', () => {
  it('maps call_started to listening', () => {
    expect(orbStateFromEvent('call_started')).toBe(ORB_STATES.LISTENING);
  });
  it('maps agent_start_talking to speaking', () => {
    expect(orbStateFromEvent('agent_start_talking')).toBe(ORB_STATES.SPEAKING);
  });
  it('maps agent_stop_talking to listening', () => {
    expect(orbStateFromEvent('agent_stop_talking')).toBe(ORB_STATES.LISTENING);
  });
  it('maps call_ended and error to idle', () => {
    expect(orbStateFromEvent('call_ended')).toBe(ORB_STATES.IDLE);
    expect(orbStateFromEvent('error')).toBe(ORB_STATES.IDLE);
  });
  it('returns null for unknown events (leaves state alone)', () => {
    expect(orbStateFromEvent('unknown_event')).toBeNull();
    expect(orbStateFromEvent(undefined)).toBeNull();
    expect(orbStateFromEvent('')).toBeNull();
  });
});
