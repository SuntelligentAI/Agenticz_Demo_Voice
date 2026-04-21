import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyWebhookEvent,
  extractCapturedFields,
} from '../lib/retell-webhook.js';

function makeFakeDb() {
  const state = {
    demoCallByRetellId: new Map(),
    events: [],
    updates: [],
  };
  const api = {
    state,
    _seedDemoCall({ id, retellCallId, startedAt = null }) {
      state.demoCallByRetellId.set(retellCallId, {
        id,
        started_at: startedAt,
      });
    },
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT id, started_at FROM demo_calls WHERE retell_call_id/.test(sql)) {
        const row = state.demoCallByRetellId.get(args[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT id FROM call_events\s+WHERE demo_call_id/.test(sql)) {
        const [demoCallId, event, payload] = args;
        const hit = state.events.find(
          (e) =>
            e.demo_call_id === demoCallId &&
            e.event_type === event &&
            e.payload === payload,
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^\s*INSERT INTO call_events/.test(sql)) {
        const [id, demo_call_id, event_type, payload, received_at] = args;
        state.events.push({ id, demo_call_id, event_type, payload, received_at });
        return { rows: [] };
      }
      if (/^\s*UPDATE demo_calls/.test(sql)) {
        state.updates.push({ sql, args });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return api;
}

describe('extractCapturedFields', () => {
  it('returns null when call_analysis is missing', () => {
    expect(extractCapturedFields({})).toBeNull();
    expect(extractCapturedFields(null)).toBeNull();
    expect(extractCapturedFields({ call_analysis: 'not an object' })).toBeNull();
  });

  it('extracts snake_case custom_analysis_data keys', () => {
    const fields = extractCapturedFields({
      call_analysis: {
        custom_analysis_data: {
          interested_in_follow_up: true,
          proposed_slot: 'Thursday 2pm',
          qualifying_notes: 'Needs a warehouse quote.',
        },
      },
    });
    expect(fields.interestedInFollowUp).toBe(true);
    expect(fields.proposedSlot).toBe('Thursday 2pm');
    expect(fields.qualifyingNotes).toBe('Needs a warehouse quote.');
  });

  it('accepts camelCase custom_analysis_data keys too', () => {
    const fields = extractCapturedFields({
      call_analysis: {
        custom_analysis_data: {
          interestedInFollowUp: false,
          proposedSlot: 'Fri 10am',
          qualifyingNotes: 'Not a fit.',
        },
      },
    });
    expect(fields.interestedInFollowUp).toBe(false);
    expect(fields.proposedSlot).toBe('Fri 10am');
    expect(fields.qualifyingNotes).toBe('Not a fit.');
  });

  it('leaves missing fields as null (does not invent data)', () => {
    const fields = extractCapturedFields({
      call_analysis: { custom_analysis_data: { proposed_slot: 'Mon 3pm' } },
    });
    expect(fields.interestedInFollowUp).toBeNull();
    expect(fields.proposedSlot).toBe('Mon 3pm');
    expect(fields.qualifyingNotes).toBeNull();
  });

  it('rejects wrong-type values (interested must be boolean; slot/notes must be non-empty strings)', () => {
    const fields = extractCapturedFields({
      call_analysis: {
        custom_analysis_data: {
          interested_in_follow_up: 'yes',
          proposed_slot: '   ',
          qualifying_notes: 42,
        },
      },
    });
    expect(fields.interestedInFollowUp).toBeNull();
    expect(fields.proposedSlot).toBeNull();
    expect(fields.qualifyingNotes).toBeNull();
  });

  it('includes bonus scalar fields from call_analysis when present', () => {
    const fields = extractCapturedFields({
      call_analysis: {
        user_sentiment: 'Positive',
        call_successful: true,
      },
    });
    expect(fields.userSentiment).toBe('Positive');
    expect(fields.callSuccessful).toBe(true);
  });
});

describe('applyWebhookEvent — call_analyzed', () => {
  let db;
  beforeEach(() => {
    db = makeFakeDb();
  });

  it('persists transcript, recording URL, summary, and captured fields; does NOT touch status', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      call_id: 'call_abc',
      transcript: 'Agent: Hi\nUser: Hello, yes I have a moment.',
      recording_url: 'https://retellai.com/rec/abc.wav',
      call_analysis: {
        call_summary: 'Prospect was interested; booked for Thursday 2pm.',
        user_sentiment: 'Positive',
        call_successful: true,
        custom_analysis_data: {
          interested_in_follow_up: true,
          proposed_slot: 'Thursday 2pm',
          qualifying_notes: 'Needs two warehouses quoted.',
        },
      },
    };
    const rawBody = JSON.stringify({ event: 'call_analyzed', call });

    const r = await applyWebhookEvent({
      rawBody,
      event: 'call_analyzed',
      call,
      receivedAt: 2_000_000,
      db,
    });
    info.mockRestore();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    expect(db.state.events).toHaveLength(1);
    expect(db.state.events[0].event_type).toBe('call_analyzed');

    expect(db.state.updates).toHaveLength(1);
    const update = db.state.updates[0];
    expect(update.sql).not.toMatch(/status\s*=/);
    expect(update.sql).toMatch(/UPDATE demo_calls/);
    expect(update.sql).toMatch(/transcript = \?/);
    expect(update.sql).toMatch(/recording_url = \?/);
    expect(update.sql).toMatch(/ai_summary = \?/);
    expect(update.sql).toMatch(/captured_fields = \?/);

    const [transcript, recordingUrl, aiSummary, capturedJson, id] =
      update.args;
    expect(transcript).toMatch(/^Agent:/);
    expect(recordingUrl).toBe('https://retellai.com/rec/abc.wav');
    expect(aiSummary).toBe(
      'Prospect was interested; booked for Thursday 2pm.',
    );
    const captured = JSON.parse(capturedJson);
    expect(captured.interestedInFollowUp).toBe(true);
    expect(captured.proposedSlot).toBe('Thursday 2pm');
    expect(captured.qualifyingNotes).toBe('Needs two warehouses quoted.');
    expect(id).toBe('demo-1');
  });

  it('is idempotent on replay (same raw body → no duplicate insert/update)', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      call_id: 'call_abc',
      transcript: 'A',
      recording_url: 'https://x',
      call_analysis: { call_summary: 's' },
    };
    const rawBody = JSON.stringify({ event: 'call_analyzed', call });

    await applyWebhookEvent({
      rawBody,
      event: 'call_analyzed',
      call,
      receivedAt: 1,
      db,
    });
    const second = await applyWebhookEvent({
      rawBody,
      event: 'call_analyzed',
      call,
      receivedAt: 2,
      db,
    });
    info.mockRestore();

    expect(second.body).toEqual({ ok: true, ignored: 'duplicate_event' });
    expect(db.state.events).toHaveLength(1);
    expect(db.state.updates).toHaveLength(1);
  });

  it('copes with a call_analyzed event that has no analysis object', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = { call_id: 'call_abc' };
    const rawBody = JSON.stringify({ event: 'call_analyzed', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'call_analyzed',
      call,
      receivedAt: 1,
      db,
    });
    info.mockRestore();

    expect(r.status).toBe(200);
    expect(db.state.updates).toHaveLength(1);
    const args = db.state.updates[0].args;
    // transcript, recording_url, ai_summary, captured_fields all null
    expect(args[0]).toBeNull();
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeNull();
    expect(args[4]).toBe('demo-1');
  });
});
