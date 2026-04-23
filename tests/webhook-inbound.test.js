import { describe, it, expect, beforeEach, vi } from 'vitest';

// Make sure the receptionist agent id is recognised by the webhook helper.
process.env.RETELL_RECEPTIONIST_AGENT_ID = 'agent_receptionist_test';
process.env.RETELL_RECEPTIONIST_NUMBER = '+14165550000';

import { applyWebhookEvent } from '../lib/retell-webhook.js';

function makeFakeDb() {
  const state = {
    demoCallsByRetellId: new Map(),
    demoCallsById: new Map(),
    stages: [],
    events: [],
    updates: [],
    inserts: [],
  };
  const api = {
    state,
    _seedDemoCall({ id, retellCallId, startedAt = null }) {
      const row = { id, started_at: startedAt };
      state.demoCallsByRetellId.set(retellCallId, row);
      state.demoCallsById.set(id, row);
    },
    _seedStage(row) {
      state.stages.push(row);
    },
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT id, started_at FROM demo_calls WHERE retell_call_id/.test(sql)) {
        const row = state.demoCallsByRetellId.get(args[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT \* FROM receptionist_stages\s+WHERE cleared_at IS NULL/.test(sql)) {
        const [now] = args;
        const rows = state.stages
          .filter((s) => s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      if (/^\s*INSERT INTO demo_calls/.test(sql)) {
        const [id] = args;
        state.inserts.push({ sql, args });
        const row = { id, started_at: null };
        state.demoCallsByRetellId.set(args[8], row);
        state.demoCallsById.set(id, row);
        return { rows: [] };
      }
      if (/^\s*SELECT id FROM call_events\s+WHERE demo_call_id/.test(sql)) {
        const [demoCallId, event, payload] = args;
        const hit = state.events.find(
          (e) => e.demo_call_id === demoCallId && e.event_type === event && e.payload === payload,
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

describe('webhook — inbound receptionist call_started', () => {
  let db;
  beforeEach(() => {
    db = makeFakeDb();
  });

  it('auto-creates a receptionist demo_calls row when the call arrives for the receptionist agent', async () => {
    // No row exists yet — the call has never been seen.
    // There IS an active stage to link to.
    const stage = {
      id: 'stage-1', user_id: 'user-42',
      agent_name: 'Ava', company_name: 'Acme',
      company_description: 'desc', call_purpose: 'purpose',
      staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
    };
    db._seedStage(stage);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const call = {
      call_id: 'call_inb_1',
      agent_id: 'agent_receptionist_test',
      direction: 'inbound',
      from_number: '+15551231234',
      to_number: '+14165550000',
      start_timestamp: 1_700_000_000_000,
    };
    const rawBody = JSON.stringify({ event: 'call_started', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 1_700_000_000_500,
      db,
    });
    info.mockRestore();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    // An INSERT for the demo_calls row happened, product='receptionist', user=stage user
    expect(db.state.inserts).toHaveLength(1);
    const insert = db.state.inserts[0];
    expect(insert.sql).toMatch(/INSERT INTO demo_calls/);
    expect(insert.sql).toMatch(/'receptionist'/);
    // args shape: [id, user_id, agent_name, company_name, company_description,
    //              call_purpose, prospect_name, prospect_phone,
    //              retell_call_id, created_at]
    expect(insert.args[1]).toBe('user-42');
    expect(insert.args[2]).toBe('Ava');
    expect(insert.args[3]).toBe('Acme');
    expect(insert.args[7]).toBe('+15551231234'); // prospect_phone = from_number
    expect(insert.args[8]).toBe('call_inb_1');

    // Then the normal call_started branch runs: UPDATE status=in_progress
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].sql).toMatch(/status = 'in_progress'/);
  });

  it('falls back to sentinel user when no stage is active', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const call = {
      call_id: 'call_inb_2',
      agent_id: 'agent_receptionist_test',
      direction: 'inbound',
      from_number: '+15551111111',
      to_number: '+14165550000',
    };
    const rawBody = JSON.stringify({ event: 'call_started', call });
    await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 2,
      db,
    });
    info.mockRestore();

    expect(db.state.inserts).toHaveLength(1);
    expect(db.state.inserts[0].args[1]).toBe('system-anonymous');
  });

  it('does NOT auto-create a row for unknown (non-receptionist) inbound calls', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = {
      call_id: 'call_unknown',
      agent_id: 'agent_something_else',
      to_number: '+14167777777',
    };
    const rawBody = JSON.stringify({ event: 'call_started', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 3,
      db,
    });
    warn.mockRestore();

    expect(r.body.ignored).toBe('call_not_found');
    expect(db.state.inserts).toHaveLength(0);
  });

  it('only creates one row across multiple events for the same inbound call', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      call_id: 'call_inb_3',
      agent_id: 'agent_receptionist_test',
      direction: 'inbound',
      from_number: '+15552222222',
      to_number: '+14165550000',
      start_timestamp: 1_700_000_000_000,
      end_timestamp: 1_700_000_030_000,
      disconnection_reason: 'user_hangup',
    };

    await applyWebhookEvent({
      rawBody: JSON.stringify({ event: 'call_started', call }),
      event: 'call_started',
      call,
      receivedAt: 1,
      db,
    });
    await applyWebhookEvent({
      rawBody: JSON.stringify({ event: 'call_ended', call }),
      event: 'call_ended',
      call,
      receivedAt: 2,
      db,
    });
    info.mockRestore();

    expect(db.state.inserts).toHaveLength(1);
    expect(db.state.updates).toHaveLength(2); // status=in_progress, then status=ended
  });
});
