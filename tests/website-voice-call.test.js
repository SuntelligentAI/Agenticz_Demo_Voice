import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.RETELL_API_KEY = 'test-retell-key';
process.env.RETELL_WEBSITE_VOICE_AGENT_ID = 'agent_wv_test';

const mocks = vi.hoisted(() => {
  const state = {
    settings: new Map(),
    settingsUpdatedAt: new Map(),
    stages: [],
    inserts: [],
    users: new Map(),
    logs: [],
  };
  const db = {
    state,
    execute: async ({ sql, args }) => {
      if (/^\s*SELECT id, email FROM users WHERE email/i.test(sql)) {
        const u = state.users.get(args[0]);
        return { rows: u ? [u] : [] };
      }
      if (/^\s*SELECT value FROM system_settings WHERE key/i.test(sql)) {
        const v = state.settings.get(args[0]);
        return { rows: v == null ? [] : [{ value: v }] };
      }
      if (/^\s*SELECT updated_at FROM system_settings WHERE key/i.test(sql)) {
        const v = state.settingsUpdatedAt.get(args[0]);
        return { rows: v == null ? [] : [{ updated_at: v }] };
      }
      if (/^\s*SELECT MAX\(staged_at\) AS latest_staged/i.test(sql)) {
        const latestStaged = state.stages.reduce((m, s) => Math.max(m, s.staged_at || 0), 0);
        const latestCleared = state.stages.reduce((m, s) => Math.max(m, s.cleared_at || 0), 0);
        return { rows: [{ latest_staged: latestStaged, latest_cleared: latestCleared }] };
      }
      if (/^\s*SELECT \* FROM website_voice_stages\s+WHERE user_id =/i.test(sql)) {
        const [userId, now] = args;
        const rows = state.stages
          .filter((s) => s.user_id === userId && s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      if (/^\s*INSERT INTO system_settings_log/i.test(sql)) {
        state.logs.push({ key: args[1], value: args[2], reason: args[4] });
        return { rows: [] };
      }
      if (/^\s*INSERT INTO system_settings\b/i.test(sql)) {
        state.settings.set(args[0], args[1]);
        state.settingsUpdatedAt.set(args[0], args[2]);
        return { rows: [] };
      }
      if (/^\s*INSERT INTO demo_calls/i.test(sql)) {
        state.inserts.push({ sql, args });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { db };
});

vi.mock('../lib/db.js', () => ({ getDb: () => mocks.db }));

// Provide a controllable fake for retell.createWebCall used by the handler.
const retellMock = vi.hoisted(() => ({
  createWebCall: vi.fn(),
}));
vi.mock('../lib/retell.js', async () => {
  const actual = await vi.importActual('../lib/retell.js');
  return { ...actual, createWebCall: retellMock.createWebCall };
});

let handler;
beforeAll(async () => {
  const mod = await import('../api/website-voice/web-call.js');
  handler = mod.default;
});

beforeEach(() => {
  mocks.db.state.settings.clear();
  mocks.db.state.settingsUpdatedAt.clear();
  mocks.db.state.stages.length = 0;
  mocks.db.state.inserts.length = 0;
  mocks.db.state.logs.length = 0;
  mocks.db.state.users.clear();
  mocks.db.state.users.set('gs@example.com', { id: 'user-1', email: 'gs@example.com' });
  retellMock.createWebCall.mockReset();
});

async function makeCookie() {
  const token = await new SignJWT({ email: 'gs@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
  return `agenticz_session=${token}`;
}

function seedStage({ now = Date.now(), userId = 'user-1' } = {}) {
  mocks.db.state.stages.push({
    id: 's1', user_id: userId,
    agent_name: 'Ava', company_name: 'Acme',
    company_description: 'desc', call_purpose: 'purpose',
    staged_at: now, expires_at: now + 10 * 60 * 1000, cleared_at: null,
  });
}

function createMockRes() {
  const headers = {};
  let statusCode = 0;
  let body;
  return {
    setHeader(n, v) { headers[n.toLowerCase()] = v; },
    getHeader(n) { return headers[n.toLowerCase()]; },
    status(c) { statusCode = c; return this; },
    send(p) { body = p; return this; },
    json(p) { body = p; return this; },
    end(p) { if (p !== undefined) body = p; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

describe('POST /api/website-voice/web-call', () => {
  it('401 without a session cookie', async () => {
    const req = { method: 'POST', headers: {}, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('405 for non-POST methods', async () => {
    const cookie = await makeCookie();
    const req = { method: 'GET', headers: { cookie }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('503 when the line is off', async () => {
    const cookie = await makeCookie();
    mocks.db.state.settings.set('website_voice_enabled', 'false');
    seedStage();
    const req = { method: 'POST', headers: { cookie }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Line is off' });
  });

  it('400 when no stage is active', async () => {
    const cookie = await makeCookie();
    mocks.db.state.settings.set('website_voice_enabled', 'true');
    // Recent updated_at so the idle auto-off helper doesn't fire.
    mocks.db.state.settingsUpdatedAt.set('website_voice_enabled', Date.now());
    const req = { method: 'POST', headers: { cookie }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'No active stage' });
  });

  it('200 happy path: mints a web call + inserts demo_calls row', async () => {
    const cookie = await makeCookie();
    mocks.db.state.settings.set('website_voice_enabled', 'true');
    mocks.db.state.settingsUpdatedAt.set('website_voice_enabled', Date.now());
    seedStage();
    retellMock.createWebCall.mockResolvedValue({
      callId: 'call_wv_1',
      accessToken: 'tok_abc',
    });

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = { method: 'POST', headers: { cookie }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();

    expect(res.statusCode).toBe(200);
    expect(res.body.callId).toBe('call_wv_1');
    expect(res.body.accessToken).toBe('tok_abc');
    expect(typeof res.body.demoCallId).toBe('string');

    // Retell was called with dynamic variables from the stage
    expect(retellMock.createWebCall).toHaveBeenCalledTimes(1);
    const retellArgs = retellMock.createWebCall.mock.calls[0][0];
    expect(retellArgs.agentId).toBe('agent_wv_test');
    expect(retellArgs.retellLlmDynamicVariables).toEqual({
      agent_name: 'Ava',
      company_name: 'Acme',
      company_description: 'desc',
      call_purpose: 'purpose',
    });
    expect(retellArgs.metadata).toEqual({
      demo_call_id: res.body.demoCallId,
      user_id: 'user-1',
      product: 'website_voice_bot',
    });

    // demo_calls row inserted with product='website_voice_bot'
    expect(mocks.db.state.inserts).toHaveLength(1);
    expect(mocks.db.state.inserts[0].sql).toMatch(/'website_voice_bot'/);
    expect(mocks.db.state.inserts[0].sql).toMatch(/'in_progress'/);
  });

  it('502 when Retell throws', async () => {
    const cookie = await makeCookie();
    mocks.db.state.settings.set('website_voice_enabled', 'true');
    mocks.db.state.settingsUpdatedAt.set('website_voice_enabled', Date.now());
    seedStage();
    retellMock.createWebCall.mockRejectedValue(new Error('Retell boom'));

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = { method: 'POST', headers: { cookie }, body: {} };
    const res = createMockRes();
    await handler(req, res);
    err.mockRestore();

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Could not start web call' });
    expect(mocks.db.state.inserts).toHaveLength(0);
  });

  it('500 when the agent id is not configured', async () => {
    const saved = process.env.RETELL_WEBSITE_VOICE_AGENT_ID;
    delete process.env.RETELL_WEBSITE_VOICE_AGENT_ID;
    try {
      const cookie = await makeCookie();
      mocks.db.state.settings.set('website_voice_enabled', 'true');
      mocks.db.state.settingsUpdatedAt.set('website_voice_enabled', Date.now());
      seedStage();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = { method: 'POST', headers: { cookie }, body: {} };
      const res = createMockRes();
      await handler(req, res);
      err.mockRestore();
      expect(res.statusCode).toBe(500);
    } finally {
      if (saved) process.env.RETELL_WEBSITE_VOICE_AGENT_ID = saved;
    }
  });
});
