// Pure mapping from Retell Web SDK events to the CSS state class applied to
// the pulsing orb. Exported so the client JS and tests can share it without
// a build step (client-side duplicates the same tiny table to stay
// classic-script-friendly; this file is the authoritative definition).

export const ORB_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  SPEAKING: 'speaking',
});

// Returns the next orb state for a given event, or null to leave the state
// unchanged. Unknown events return null (don't clear the current state).
export function orbStateFromEvent(eventName) {
  switch (eventName) {
    case 'call_started':
      return ORB_STATES.LISTENING;
    case 'agent_start_talking':
      return ORB_STATES.SPEAKING;
    case 'agent_stop_talking':
      return ORB_STATES.LISTENING;
    case 'call_ended':
    case 'error':
      return ORB_STATES.IDLE;
    default:
      return null;
  }
}
