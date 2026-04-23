import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

// Shared fake DB state that the mocked getDb will return.
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

let logoutHandler;
beforeAll(async () => {
  const mod = await import('../api/auth/logout.js');
  logoutHandler = mod.default;
});

beforeEach(() => {
  mocks.db.state.settings.clear();
  mocks.db.state.settingsUpdatedAt.clear();
  mocks.db.state.logs.length = 0;
  mocks.db.state.users.clear();
  // Seed "line is on"
  mocks.db.state.settings.set('receptionist_line_enabled', 'true');
  mocks.db.state.settingsUpdatedAt.set('receptionist_line_enabled', 1);
});

async function makeSessionCookie(email) {
  const token = await new SignJWT({ email })
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

describe('POST /api/auth/logout — auto-off trigger A', () => {
  it('flips the line off with reason auto_off:logout before clearing the cookie', async () => {
    mocks.db.state.users.set('gs@example.com', {
      id: 'user-1',
      email: 'gs@example.com',
    });
    const cookie = await makeSessionCookie('gs@example.com');
    const req = {
      method: 'POST',
      headers: { cookie },
    };
    const res = createMockRes();
    await logoutHandler(req, res);

    expect(res.statusCode).toBe(200);
    // Cookie cleared (Max-Age=0)
    const setCookie = res.getHeader('Set-Cookie');
    expect(setCookie).toMatch(/^agenticz_session=/);
    expect(setCookie).toMatch(/Max-Age=0/);

    // Both product lines get flipped off — receptionist AND website voice.
    expect(mocks.db.state.settings.get('receptionist_line_enabled')).toBe('false');
    expect(mocks.db.state.settings.get('website_voice_enabled')).toBe('false');

    const receptionistLog = mocks.db.state.logs.find(
      (l) => l.key === 'receptionist_line_enabled',
    );
    expect(receptionistLog).toMatchObject({
      value: 'false',
      reason: 'auto_off:logout',
      updated_by: 'gs@example.com',
    });
    const webVoiceLog = mocks.db.state.logs.find(
      (l) => l.key === 'website_voice_enabled',
    );
    expect(webVoiceLog).toMatchObject({
      value: 'false',
      reason: 'auto_off:logout',
      updated_by: 'gs@example.com',
    });
  });

  it('still clears the cookie even if there is no session (best-effort flip)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = { method: 'POST', headers: {} };
    const res = createMockRes();
    await logoutHandler(req, res);
    warn.mockRestore();

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Set-Cookie')).toMatch(/Max-Age=0/);
    // Both lines flipped with updated_by='unknown'
    expect(mocks.db.state.settings.get('receptionist_line_enabled')).toBe('false');
    expect(mocks.db.state.settings.get('website_voice_enabled')).toBe('false');
    for (const log of mocks.db.state.logs) {
      expect(log.reason).toBe('auto_off:logout');
      expect(log.updated_by).toBe('unknown');
    }
    expect(mocks.db.state.logs.length).toBeGreaterThanOrEqual(2);
  });

  it('returns 405 for non-POST methods', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();
    await logoutHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
