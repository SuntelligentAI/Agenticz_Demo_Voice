import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const WEBHOOK_SECRET = 'test-webhook-secret-at-least-32-bytes-long!';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.RETELL_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Shared fake DB state hoisted for vi.mock.
const mocks = vi.hoisted(() => {
  return {
    fakeDb: { execute: async () => ({ rows: [] }) },
  };
});

vi.mock('../lib/db.js', () => ({
  getDb: () => mocks.fakeDb,
}));

function makeFakeDb(initialStages = [], { lineEnabled = true } = {}) {
  const state = {
    stages: initialStages,
    settings: new Map([
      ['receptionist_line_enabled', lineEnabled ? 'true' : 'false'],
    ]),
  };
  return {
    state,
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT value FROM system_settings WHERE key/i.test(sql)) {
        const v = state.settings.get(args[0]);
        return { rows: v == null ? [] : [{ value: v }] };
      }
      if (/^\s*SELECT \* FROM receptionist_stages\s+WHERE cleared_at IS NULL/i.test(sql)) {
        const [now] = args;
        const rows = state.stages
          .filter((s) => s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      return { rows: [] };
    }),
  };
}

function signBody(rawBody, timestamp = Date.now()) {
  const digest = createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody + String(timestamp))
    .digest('hex');
  return `v=${timestamp},d=${digest}`;
}

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
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    status(c) { statusCode = c; return this; },
    send(p) { body = p; return this; },
    json(p) { body = p; return this; },
    end(p) { if (p !== undefined) body = p; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

let handler;
beforeAll(async () => {
  const mod = await import('../api/receptionist/context.js');
  handler = mod.default;
});

const FALLBACK_AGENT_MATCHER = /Agenticz demo line/i;

describe('POST /api/receptionist/context', () => {
  beforeEach(() => {
    // Reset the DB mock to empty defaults each test.
    mocks.fakeDb = { execute: async () => ({ rows: [] }) };
  });

  it('returns 401 without a signature', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = mockReq('POST', {}, '{"call":{"call_id":"c1"}}');
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    warn.mockRestore();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with a tampered signature', async () => {
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody).replace(/d=./, 'd=x');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    warn.mockRestore();
    expect(res.statusCode).toBe(401);
  });

  it('returns fallback context when line is disabled (even with an active stage)', async () => {
    mocks.fakeDb = makeFakeDb(
      [
        {
          id: 's1', user_id: 'u1',
          agent_name: 'Ava', company_name: 'Acme',
          company_description: 'desc', call_purpose: 'purpose',
          staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
        },
      ],
      { lineEnabled: false },
    );
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.dynamic_variables.agent_name).toMatch(FALLBACK_AGENT_MATCHER);
  });

  it('returns fallback context when line is enabled but no stage is active', async () => {
    mocks.fakeDb = makeFakeDb([], { lineEnabled: true });
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.dynamic_variables.agent_name).toMatch(FALLBACK_AGENT_MATCHER);
  });

  it('returns staged context when line is enabled and a stage is active', async () => {
    mocks.fakeDb = makeFakeDb(
      [
        {
          id: 's1', user_id: 'u1',
          agent_name: 'Ava', company_name: 'Acme Roofing',
          company_description: 'We install commercial flat roofs.',
          call_purpose: 'Qualify inbound leads.',
          staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: null,
        },
      ],
      { lineEnabled: true },
    );
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.dynamic_variables).toEqual({
      agent_name: 'Ava',
      company_name: 'Acme Roofing',
      company_description: 'We install commercial flat roofs.',
      call_purpose: 'Qualify inbound leads.',
    });
  });

  it('returns fallback when the staged row has already expired', async () => {
    mocks.fakeDb = makeFakeDb(
      [
        {
          id: 's1', user_id: 'u1',
          agent_name: 'Ava', company_name: 'Acme',
          company_description: 'desc', call_purpose: 'purpose',
          staged_at: 1, expires_at: 2, cleared_at: null,
        },
      ],
      { lineEnabled: true },
    );
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.dynamic_variables.agent_name).toMatch(FALLBACK_AGENT_MATCHER);
  });

  it('returns fallback when the staged row was cleared', async () => {
    mocks.fakeDb = makeFakeDb(
      [
        {
          id: 's1', user_id: 'u1',
          agent_name: 'Ava', company_name: 'Acme',
          company_description: 'desc', call_purpose: 'purpose',
          staged_at: 1, expires_at: 9_999_999_999_999, cleared_at: 2,
        },
      ],
      { lineEnabled: true },
    );
    const rawBody = '{"call":{"call_id":"c1"}}';
    const sig = signBody(rawBody);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = mockReq('POST', { 'x-retell-signature': sig }, rawBody);
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.dynamic_variables.agent_name).toMatch(FALLBACK_AGENT_MATCHER);
  });
});
