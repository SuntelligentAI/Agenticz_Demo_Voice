import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyRetellSignature,
  mapOutcome,
  applyWebhookEvent,
} from '../lib/retell-webhook.js';

const SECRET = 'test-webhook-secret-at-least-32-bytes-long!';

function signBody(rawBody, timestamp = Date.now(), secret = SECRET) {
  const digest = createHmac('sha256', secret)
    .update(rawBody + String(timestamp))
    .digest('hex');
  return `v=${timestamp},d=${digest}`;
}

describe('verifyRetellSignature', () => {
  it('accepts a valid v=<ts>,d=<hex-hmac> signature', () => {
    const body = '{"event":"call_started","call":{"call_id":"c1"}}';
    const sig = signBody(body);
    expect(verifyRetellSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"event":"call_started","call":{"call_id":"c1"}}';
    const sig = signBody(body);
    expect(verifyRetellSignature(body + 'x', sig, SECRET)).toBe(false);
  });

  it('rejects a tampered digest', () => {
    const body = '{"event":"call_started","call":{"call_id":"c1"}}';
    const sig = signBody(body);
    const m = /^v=(\d+),d=(.+)$/.exec(sig);
    const tamperedDigest = (m[2][0] === 'A' ? 'B' : 'A') + m[2].slice(1);
    const tampered = `v=${m[1]},d=${tamperedDigest}`;
    expect(verifyRetellSignature(body, tampered, SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyRetellSignature('{}', undefined, SECRET)).toBe(false);
    expect(verifyRetellSignature('{}', '', SECRET)).toBe(false);
  });

  it('rejects a missing secret', () => {
    const body = '{}';
    const sig = signBody(body);
    expect(verifyRetellSignature(body, sig, undefined)).toBe(false);
    expect(verifyRetellSignature(body, sig, '')).toBe(false);
  });

  it('rejects signatures in the wrong format', () => {
    const body = '{}';
    expect(verifyRetellSignature(body, 'abc', SECRET)).toBe(false);
    expect(verifyRetellSignature(body, 'v1=deadbeef', SECRET)).toBe(false);
    expect(verifyRetellSignature(body, 'deadbeef'.repeat(8), SECRET)).toBe(
      false,
    );
    // timestamp isn't digits
    expect(verifyRetellSignature(body, 'v=abc,d=xxxxxx', SECRET)).toBe(false);
    // missing the d= part
    expect(verifyRetellSignature(body, 'v=12345', SECRET)).toBe(false);
  });

  it('rejects a digest of the wrong byte length without throwing', () => {
    const body = '{}';
    const ts = Date.now();
    // too short
    const shortSig = `v=${ts},d=Zm9v`;
    expect(verifyRetellSignature(body, shortSig, SECRET)).toBe(false);
    // too long
    const longSig = `v=${ts},d=${'A'.repeat(200)}`;
    expect(verifyRetellSignature(body, longSig, SECRET)).toBe(false);
  });

  it('rejects a signature produced with a different secret', () => {
    const body = '{"event":"call_started","call":{"call_id":"c1"}}';
    const sig = signBody(body, Date.now(), 'different-secret-value');
    expect(verifyRetellSignature(body, sig, SECRET)).toBe(false);
  });

  it('rejects a timestamp older than 5 minutes (replay protection)', () => {
    const body = '{}';
    const now = 2_000_000_000_000;
    const oldTs = now - (5 * 60 * 1000 + 1);
    const sig = signBody(body, oldTs);
    expect(verifyRetellSignature(body, sig, SECRET, now)).toBe(false);
  });

  it('rejects a timestamp more than 5 minutes in the future', () => {
    const body = '{}';
    const now = 2_000_000_000_000;
    const futureTs = now + (5 * 60 * 1000 + 1);
    const sig = signBody(body, futureTs);
    expect(verifyRetellSignature(body, sig, SECRET, now)).toBe(false);
  });

  it('accepts a timestamp at the edge of the skew window', () => {
    const body = '{}';
    const now = 2_000_000_000_000;
    const edgeTs = now - 5 * 60 * 1000;
    const sig = signBody(body, edgeTs);
    expect(verifyRetellSignature(body, sig, SECRET, now)).toBe(true);
  });
});

describe('mapOutcome', () => {
  it('voicemail_reached → voicemail (beats hangup reasons)', () => {
    expect(
      mapOutcome({
        disconnection_reason: 'voicemail_reached',
        call_status: 'ended',
      }),
    ).toBe('voicemail');
  });
  it('user_hangup → completed', () => {
    expect(mapOutcome({ disconnection_reason: 'user_hangup' })).toBe(
      'completed',
    );
  });
  it('agent_hangup → completed', () => {
    expect(mapOutcome({ disconnection_reason: 'agent_hangup' })).toBe(
      'completed',
    );
  });
  it('call_status no_answer → no_answer', () => {
    expect(mapOutcome({ call_status: 'no_answer' })).toBe('no_answer');
  });
  it('call_status error → failed', () => {
    expect(mapOutcome({ call_status: 'error' })).toBe('failed');
  });
  it('call_status failed → failed', () => {
    expect(mapOutcome({ call_status: 'failed' })).toBe('failed');
  });
  it('falls back to completed when nothing matches', () => {
    expect(mapOutcome({})).toBe('completed');
    expect(mapOutcome(null)).toBe('completed');
  });
});

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
        const retellCallId = args[0];
        const row = state.demoCallByRetellId.get(retellCallId);
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

describe('applyWebhookEvent', () => {
  let db;
  beforeEach(() => {
    db = makeFakeDb();
  });

  it('returns ignored when retell_call_id does not match any demo_call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await applyWebhookEvent({
      rawBody: '{}',
      event: 'call_started',
      call: { call_id: 'call_unknown' },
      receivedAt: 1000,
      db,
    });
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBe('call_not_found');
    expect(db.state.events).toHaveLength(0);
    expect(db.state.updates).toHaveLength(0);
  });

  it('call_started: inserts event and updates status to in_progress with started_at', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = { call_id: 'call_abc', start_timestamp: 1_700_000_000_000 };
    const rawBody = JSON.stringify({ event: 'call_started', call });
    const r = await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 1_700_000_005_000,
      db,
    });
    info.mockRestore();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(db.state.events).toHaveLength(1);
    expect(db.state.events[0].event_type).toBe('call_started');
    expect(db.state.events[0].payload).toBe(rawBody);

    expect(db.state.updates).toHaveLength(1);
    const update = db.state.updates[0];
    expect(update.sql).toMatch(/status = 'in_progress'/);
    expect(update.args).toEqual([1_700_000_000_000, 'demo-1']);
  });

  it('call_started: falls back to receivedAt when start_timestamp is missing', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = { call_id: 'call_abc' };
    const rawBody = JSON.stringify({ event: 'call_started', call });
    await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 777,
      db,
    });
    info.mockRestore();

    expect(db.state.updates[0].args).toEqual([777, 'demo-1']);
  });

  it('call_ended: sets status=ended, ended_at, duration, outcome', async () => {
    db._seedDemoCall({
      id: 'demo-2',
      retellCallId: 'call_xyz',
      startedAt: 1_700_000_000_000,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      call_id: 'call_xyz',
      start_timestamp: 1_700_000_000_000,
      end_timestamp: 1_700_000_045_000,
      disconnection_reason: 'user_hangup',
      call_status: 'ended',
    };
    const rawBody = JSON.stringify({ event: 'call_ended', call });
    await applyWebhookEvent({
      rawBody,
      event: 'call_ended',
      call,
      receivedAt: 1_700_000_050_000,
      db,
    });
    info.mockRestore();

    const update = db.state.updates[0];
    expect(update.sql).toMatch(/status = 'ended'/);
    // args: [endedAt, durationSeconds, outcome, demoCallId]
    expect(update.args).toEqual([1_700_000_045_000, 45, 'completed', 'demo-2']);
  });

  it('call_ended: uses DB started_at when payload omits start_timestamp', async () => {
    db._seedDemoCall({
      id: 'demo-3',
      retellCallId: 'call_def',
      startedAt: 1_700_000_010_000,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = {
      call_id: 'call_def',
      end_timestamp: 1_700_000_040_000,
      disconnection_reason: 'voicemail_reached',
    };
    const rawBody = JSON.stringify({ event: 'call_ended', call });
    await applyWebhookEvent({
      rawBody,
      event: 'call_ended',
      call,
      receivedAt: 1_700_000_041_000,
      db,
    });
    info.mockRestore();

    expect(db.state.updates[0].args).toEqual([
      1_700_000_040_000,
      30,
      'voicemail',
      'demo-3',
    ]);
  });

  it('is idempotent: duplicate event (same raw body) does not re-insert or re-update', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = { call_id: 'call_abc', start_timestamp: 1_700_000_000_000 };
    const rawBody = JSON.stringify({ event: 'call_started', call });

    await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 1,
      db,
    });
    const second = await applyWebhookEvent({
      rawBody,
      event: 'call_started',
      call,
      receivedAt: 2,
      db,
    });
    info.mockRestore();

    expect(second.body).toEqual({ ok: true, ignored: 'duplicate_event' });
    expect(db.state.events).toHaveLength(1);
    expect(db.state.updates).toHaveLength(1);
  });

  it('call_analyzed: writes post-call artefacts and never touches status', async () => {
    db._seedDemoCall({ id: 'demo-1', retellCallId: 'call_abc' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const call = { call_id: 'call_abc' };
    const rawBody = JSON.stringify({ event: 'call_analyzed', call });
    await applyWebhookEvent({
      rawBody,
      event: 'call_analyzed',
      call,
      receivedAt: 1,
      db,
    });
    info.mockRestore();

    // Event is logged.
    expect(db.state.events).toHaveLength(1);
    // Exactly one UPDATE — for the analyzed fields, never for status.
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].sql).not.toMatch(/status\s*=/);
    expect(db.state.updates[0].sql).toMatch(/transcript = \?/);
  });

  it('returns ignored on bad shape without crashing', async () => {
    const r1 = await applyWebhookEvent({
      rawBody: '{}',
      event: undefined,
      call: undefined,
      receivedAt: 1,
      db,
    });
    expect(r1.body).toEqual({ ok: true, ignored: 'bad_shape' });

    const r2 = await applyWebhookEvent({
      rawBody: '{}',
      event: 'call_started',
      call: {},
      receivedAt: 1,
      db,
    });
    expect(r2.body).toEqual({ ok: true, ignored: 'missing_call_id' });
  });
});

describe('POST /api/webhooks/retell handler', () => {
  it('returns 401 when no X-Retell-Signature header is present', async () => {
    process.env.RETELL_WEBHOOK_SECRET = SECRET;
    const { default: handler } = await import('../api/webhooks/retell.js');
    const req = mockReq('POST', {}, '{}');
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  it('returns 401 when signature does not match', async () => {
    process.env.RETELL_WEBHOOK_SECRET = SECRET;
    const { default: handler } = await import('../api/webhooks/retell.js');
    const req = mockReq(
      'POST',
      { 'x-retell-signature': 'deadbeef'.repeat(8) },
      '{"event":"call_started","call":{"call_id":"c1"}}',
    );
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 405 for non-POST methods', async () => {
    process.env.RETELL_WEBHOOK_SECRET = SECRET;
    const { default: handler } = await import('../api/webhooks/retell.js');
    const req = mockReq('GET', {}, '');
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader('Allow')).toBe('POST');
  });

  it('returns 500 when RETELL_WEBHOOK_SECRET is not set', async () => {
    const saved = process.env.RETELL_WEBHOOK_SECRET;
    delete process.env.RETELL_WEBHOOK_SECRET;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { default: handler } = await import('../api/webhooks/retell.js');
      const req = mockReq('POST', {}, '{}');
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(500);
    } finally {
      err.mockRestore();
      if (saved !== undefined) process.env.RETELL_WEBHOOK_SECRET = saved;
    }
  });
});

function mockReq(method, headers, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    headers: { ...headers },
    on(event, cb) {
      if (listeners[event]) listeners[event].push(cb);
      return req;
    },
  };
  // Emit body on next tick after handlers attach
  queueMicrotask(() => {
    if (body) {
      for (const cb of listeners.data) cb(Buffer.from(body, 'utf8'));
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

function createMockRes() {
  const headers = {};
  let statusCode = 0;
  let body;
  return {
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    status(code) {
      statusCode = code;
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    end(payload) {
      if (payload !== undefined) body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}
