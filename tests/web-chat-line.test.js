import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.RETELL_CHAT_AGENT_ID = 'agent_chat_test';
process.env.RETELL_PUBLIC_KEY = 'public_key_test';
process.env.GOOGLE_RECAPTCHA_SITE_KEY = 'recaptcha_site_key_test';

const mocks = vi.hoisted(() => {
  const state = {
    settings: new Map(),
    settingsUpdatedAt: new Map(),
    logs: [],
    users: new Map(),
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
        return { rows: [{ latest_staged: 0, latest_cleared: 0 }] };
      }
      if (/^\s*SELECT value, updated_by, reason, created_at/i.test(sql)) {
        const logs = state.logs
          .filter((l) => l.key === args[0])
          .slice()
          .sort((a, b) => b.created_at - a.created_at);
        return { rows: logs.slice(0, 1) };
      }
      if (/^\s*INSERT INTO system_settings_log/i.test(sql)) {
        state.logs.push({
          key: args[1],
          value: args[2],
          updated_by: args[3],
          reason: args[4],
          created_at: args[5],
        });
        return { rows: [] };
      }
      if (/^\s*INSERT INTO system_settings\b/i.test(sql)) {
        state.settings.set(args[0], args[1]);
        state.settingsUpdatedAt.set(args[0], args[2]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { db };
});

vi.mock('../lib/db.js', () => ({ getDb: () => mocks.db }));

let handler;
beforeAll(async () => {
  const mod = await import('../api/settings/web-chat-line.js');
  handler = mod.default;
});

beforeEach(() => {
  mocks.db.state.settings.clear();
  mocks.db.state.settingsUpdatedAt.clear();
  mocks.db.state.logs.length = 0;
  mocks.db.state.users.clear();
  mocks.db.state.users.set('gs@example.com', {
    id: 'user-1',
    email: 'gs@example.com',
  });
});

async function makeCookie() {
  const token = await new SignJWT({ email: 'gs@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
  return `agenticz_session=${token}`;
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

describe('GET /api/settings/web-chat-line', () => {
  it('401 without session', async () => {
    const req = { method: 'GET', headers: {}, query: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('exposes widget config to the dashboard', async () => {
    const cookie = await makeCookie();
    const req = { method: 'GET', headers: { cookie }, query: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      chatAgentId: 'agent_chat_test',
      publicKey: 'public_key_test',
      recaptchaSiteKey: 'recaptcha_site_key_test',
    });
  });
});

describe('PUT / POST /api/settings/web-chat-line', () => {
  it('PUT with application/json flips the line on', async () => {
    const cookie = await makeCookie();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: { enabled: true },
    };
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(mocks.db.state.settings.get('web_chat_enabled')).toBe('true');
    expect(mocks.db.state.logs.at(-1).reason).toBe('manual_on');
  });

  it('POST with text/plain sendBeacon body flips the line off', async () => {
    const cookie = await makeCookie();
    // First turn on
    {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      await handler(
        {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: { enabled: true },
        },
        createMockRes(),
      );
      info.mockRestore();
    }
    // Then beacon-POST off
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const req = {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ enabled: false, reason: 'auto_off:tab_close' }),
    };
    const res = createMockRes();
    await handler(req, res);
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(mocks.db.state.settings.get('web_chat_enabled')).toBe('false');
    const log = mocks.db.state.logs.at(-1);
    expect(log.reason).toBe('auto_off:tab_close');
  });

  it('400 when enabled is missing or wrong type', async () => {
    const cookie = await makeCookie();
    const req = {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: { enabled: 'yes' },
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('405 for DELETE', async () => {
    const cookie = await makeCookie();
    const req = { method: 'DELETE', headers: { cookie } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
