import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';

// Hoisted shared state that both the `vi.mock` factory and the tests can
// reach. vi.mock calls are hoisted above imports; we need the mock factory
// to return something the tests can mutate per-test.
const mocks = vi.hoisted(() => {
  return {
    fakeDb: { execute: async () => ({ rows: [] }) },
  };
});

vi.mock('../lib/db.js', () => ({
  getDb: () => mocks.fakeDb,
}));

let auth;
let loginHandler;
beforeAll(async () => {
  auth = await import('../lib/auth.js');
  const mod = await import('../api/auth/login.js');
  loginHandler = mod.default;
});

describe('sanitizeNext', () => {
  const DEFAULT = '/voice/speed-to-lead/live';

  it('accepts a same-origin absolute path', () => {
    expect(auth.sanitizeNext('/voice/speed-to-lead/live')).toBe(
      '/voice/speed-to-lead/live',
    );
    expect(auth.sanitizeNext('/voice/speed-to-lead/live/history')).toBe(
      '/voice/speed-to-lead/live/history',
    );
    expect(auth.sanitizeNext('/')).toBe('/');
  });

  it('rejects protocol-relative URLs (//evil.com/x)', () => {
    expect(auth.sanitizeNext('//evil.com/x')).toBe(DEFAULT);
    expect(auth.sanitizeNext('//x')).toBe(DEFAULT);
  });

  it('rejects absolute URLs (http://evil.com)', () => {
    expect(auth.sanitizeNext('http://evil.com')).toBe(DEFAULT);
    expect(auth.sanitizeNext('https://evil.com/foo')).toBe(DEFAULT);
    expect(auth.sanitizeNext('javascript:alert(1)')).toBe(DEFAULT);
  });

  it('rejects undefined / non-string / empty', () => {
    expect(auth.sanitizeNext(undefined)).toBe(DEFAULT);
    expect(auth.sanitizeNext(null)).toBe(DEFAULT);
    expect(auth.sanitizeNext('')).toBe(DEFAULT);
    expect(auth.sanitizeNext(42)).toBe(DEFAULT);
    expect(auth.sanitizeNext({})).toBe(DEFAULT);
  });

  it('rejects paths containing // anywhere (not just as prefix)', () => {
    expect(auth.sanitizeNext('/foo//bar')).toBe(DEFAULT);
  });

  it('rejects paths with backslashes, whitespace, or control chars', () => {
    expect(auth.sanitizeNext('/foo\\bar')).toBe(DEFAULT);
    expect(auth.sanitizeNext('/foo bar')).toBe(DEFAULT);
    expect(auth.sanitizeNext('/foo\nbar')).toBe(DEFAULT);
    expect(auth.sanitizeNext('/foo\x00bar')).toBe(DEFAULT);
  });

  it('rejects paths longer than 512 chars', () => {
    expect(auth.sanitizeNext('/' + 'a'.repeat(600))).toBe(DEFAULT);
  });
});

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
    send(p) {
      body = p;
      return this;
    },
    json(p) {
      body = p;
      return this;
    },
    end(p) {
      if (p !== undefined) body = p;
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

describe('POST /api/auth/login with next', () => {
  const email = 'admin@agenticz.test';
  const password = 'correct horse battery staple';
  let hash;

  beforeAll(async () => {
    hash = await auth.hashPassword(password);
    mocks.fakeDb.execute = async ({ sql, args }) => {
      if (/SELECT .* FROM users WHERE email/i.test(sql)) {
        if (args[0] === email) {
          return {
            rows: [{ id: 'user-1', email, password_hash: hash }],
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    };
  });

  beforeEach(() => {
    auth._resetRateLimiter();
  });

  it('302 redirects to the sanitized next on successful login (no Accept)', async () => {
    const req = {
      method: 'POST',
      headers: {},
      body: { email, password, next: '/voice/speed-to-lead/live/history' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.getHeader('Location')).toBe(
      '/voice/speed-to-lead/live/history',
    );
    expect(res.getHeader('Set-Cookie')).toMatch(/^agenticz_session=/);
  });

  it('302 redirects to the default when next is malicious', async () => {
    const req = {
      method: 'POST',
      headers: {},
      body: { email, password, next: '//evil.com/x' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.getHeader('Location')).toBe('/voice/speed-to-lead/live');
  });

  it('302 redirects to the default when next is missing', async () => {
    const req = {
      method: 'POST',
      headers: {},
      body: { email, password },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.getHeader('Location')).toBe('/voice/speed-to-lead/live');
  });

  it('returns JSON (not 302) when Accept: application/json', async () => {
    const req = {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: { email, password, next: '/voice/speed-to-lead/live' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, next: '/voice/speed-to-lead/live' });
  });

  it('JSON response sanitizes a malicious next to the default', async () => {
    const req = {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: { email, password, next: 'http://evil.com' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.next).toBe('/voice/speed-to-lead/live');
  });

  it('on bad creds with JSON accept, 401 JSON (no redirect)', async () => {
    const req = {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: { email, password: 'wrong', next: '/voice/speed-to-lead/live' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
  });

  it('on bad creds without JSON accept, 302 back to /login preserving next', async () => {
    const req = {
      method: 'POST',
      headers: {},
      body: { email, password: 'wrong', next: '/voice/speed-to-lead/live' },
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res = createMockRes();
    await loginHandler(req, res);

    expect(res.statusCode).toBe(302);
    const location = res.getHeader('Location');
    expect(location).toContain('/login');
    expect(location).toContain('error=1');
    expect(location).toContain(
      'next=' + encodeURIComponent('/voice/speed-to-lead/live'),
    );
  });
});
