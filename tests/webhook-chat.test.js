import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.RETELL_CHAT_AGENT_ID = 'agent_chat_test';

import { applyWebhookEvent } from '../lib/retell-webhook.js';

function makeFakeDb() {
  const state = {
    demoCallsByRetellId: new Map(),
    stages: [],
    events: [],
    updates: [],
    inserts: [],
  };
  return {
    state,
    _seedStage(row) { state.stages.push(row); },
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT id, started_at FROM demo_calls WHERE retell_call_id/.test(sql)) {
        const row = state.demoCallsByRetellId.get(args[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT \* FROM web_chat_stages\s+WHERE cleared_at IS NULL/.test(sql)) {
        const [now] = args;
        const rows = state.stages
          .filter((s) => s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      if (/^\s*INSERT INTO demo_calls/i.test(sql)) {
        const [id] = args;
        state.inserts.push({ sql, args });
        const retellId = args[8];
        state.demoCallsByRetellId.set(retellId, { id, started_at: null });
        return { rows: [] };
      }
      if (/^\s*SELECT id FROM call_events\s+WHERE demo_call_id/.test(sql)) {
        const [demoCallId, event, payload] = args;
        const hit = state.events.find(
          (e) => e.demo_call_id === demoCallId && e.event_type === event && e.payload === payload,
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^\s*INSERT INTO call_events/i.test(sql)) {
        const [id, demo_call_id, event_type, payload, received_at] = args;
        state.events.push({ id, demo_call_id, event_type, payload, received_at });
        return { rows: [] };
      }
      if (/^\s*UPDATE demo_calls/i.test(sql)) {
        state.updates.push({ sql, args });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe('webhook — chat events (web bot)', () => {
  let db;
  beforeEach(() => { db = makeFakeDb(); });

  it('chat_started auto-creates a web_bot demo_calls row linked to the active stage', async () => {
    const stage = {
      id: 's1', user_id: 'user-1',
      agent_name: 'Ava', company_name: 'Acme',
      company_description: 'desc', call_purpose: 'purpose',
      staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
    };
    db._seedStage(stage);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const call = {
      chat_id: 'chat_abc',
      agent_id: 'agent_chat_test',
      start_timestamp: 1_700_000_000_000,
    };
    const rawBody = JSON.stringify({ event: 'chat_started', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'chat_started',
      call,
      receivedAt: 1_700_000_000_500,
      db,
    });
    info.mockRestore();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(db.state.inserts).toHaveLength(1);
    const ins = db.state.inserts[0];
    expect(ins.sql).toMatch(/'web_bot'/);
    expect(ins.sql).toMatch(/'in_progress'/);
    expect(ins.args[1]).toBe('user-1'); // user_id
    expect(ins.args[2]).toBe('Ava'); // agent_name
    expect(ins.args[8]).toBe('chat_abc'); // retell_call_id = chat_id
    // status update to in_progress (second UPDATE since INSERT already set status)
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].sql).toMatch(/status = 'in_progress'/);
  });

  it('chat_started falls back to the sentinel user when no stage is active', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const call = {
      chat_id: 'chat_xyz',
      agent_id: 'agent_chat_test',
    };
    const rawBody = JSON.stringify({ event: 'chat_started', call });
    await applyWebhookEvent({
      rawBody,
      event: 'chat_started',
      call,
      receivedAt: 10,
      db,
    });
    info.mockRestore();
    expect(db.state.inserts).toHaveLength(1);
    expect(db.state.inserts[0].args[1]).toBe('system-anonymous');
  });

  it('chat_ended writes transcript + summary + outcome in a single update', async () => {
    db._seedStage({
      id: 's1', user_id: 'user-1',
      agent_name: 'Ava', company_name: 'Acme',
      company_description: 'desc', call_purpose: 'purpose',
      staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      chat_id: 'chat_abc',
      agent_id: 'agent_chat_test',
      start_timestamp: 1_700_000_000_000,
      end_timestamp: 1_700_000_045_000,
      transcript: 'User: Hi\nAgent: Hello',
      chat_analysis: {
        chat_summary: 'Visitor asked about pricing, booked a follow-up.',
        custom_analysis_data: {
          interested_in_follow_up: true,
          proposed_slot: 'Thursday 2pm',
        },
      },
    };
    const rawBody = JSON.stringify({ event: 'chat_ended', call });
    await applyWebhookEvent({
      rawBody,
      event: 'chat_ended',
      call,
      receivedAt: 1_700_000_050_000,
      db,
    });
    info.mockRestore();

    // One insert (row auto-created) and one update (chat_ended fields).
    expect(db.state.inserts).toHaveLength(1);
    expect(db.state.updates).toHaveLength(1);
    const update = db.state.updates[0];
    expect(update.sql).toMatch(/status = 'ended'/);
    expect(update.sql).toMatch(/transcript = \?/);
    expect(update.sql).toMatch(/ai_summary = \?/);
    // args: [endedAt, durationSeconds, outcome, transcript, aiSummary, capturedFieldsJson, demoCallId]
    const [endedAt, durationSeconds, outcome, transcript, aiSummary, capturedJson] = update.args;
    expect(endedAt).toBe(1_700_000_045_000);
    expect(durationSeconds).toBe(45);
    expect(outcome).toBe('completed');
    expect(transcript).toMatch(/^User: Hi/);
    expect(aiSummary).toMatch(/Visitor asked/);
    const captured = JSON.parse(capturedJson);
    expect(captured.interestedInFollowUp).toBe(true);
    expect(captured.proposedSlot).toBe('Thursday 2pm');
  });

  it('chat_ended is idempotent on replay', async () => {
    db._seedStage({
      id: 's1', user_id: 'user-1',
      agent_name: 'Ava', company_name: 'Acme',
      company_description: 'desc', call_purpose: 'purpose',
      staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      chat_id: 'chat_abc',
      agent_id: 'agent_chat_test',
      transcript: 'Agent: Hi',
      chat_analysis: { chat_summary: 'short' },
    };
    const rawBody = JSON.stringify({ event: 'chat_ended', call });

    await applyWebhookEvent({
      rawBody,
      event: 'chat_ended',
      call,
      receivedAt: 1,
      db,
    });
    const second = await applyWebhookEvent({
      rawBody,
      event: 'chat_ended',
      call,
      receivedAt: 2,
      db,
    });
    info.mockRestore();

    expect(second.body).toEqual({ ok: true, ignored: 'duplicate_event' });
    expect(db.state.inserts).toHaveLength(1);
    expect(db.state.updates).toHaveLength(1);
  });

  it('ignores chat events whose agent_id does not match RETELL_CHAT_AGENT_ID', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = {
      chat_id: 'chat_stray',
      agent_id: 'agent_unrelated',
    };
    const rawBody = JSON.stringify({ event: 'chat_started', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'chat_started',
      call,
      receivedAt: 1,
      db,
    });
    warn.mockRestore();
    expect(r.body.ignored).toBe('call_not_found');
    expect(db.state.inserts).toHaveLength(0);
  });
});
