import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';

let auth;
beforeAll(async () => {
  auth = await import('../lib/auth.js');
});

describe('password hash + verify', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await auth.hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(
      await auth.verifyPassword('correct horse battery staple', hash),
    ).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await auth.hashPassword('correct horse battery staple');
    expect(await auth.verifyPassword('wrong password', hash)).toBe(false);
  });
});

describe('JWT sign + verify', () => {
  it('round-trips the email claim', async () => {
    const token = await auth.issueSession({ email: 'admin@test.example' });
    const payload = await auth.verifySession(token);
    expect(payload?.email).toBe('admin@test.example');
  });

  it('rejects a tampered token', async () => {
    const token = await auth.issueSession({ email: 'admin@test.example' });
    expect(await auth.verifySession(token + 'x')).toBeNull();
  });

  it('rejects gibberish', async () => {
    expect(await auth.verifySession('not-a-jwt')).toBeNull();
  });
});

function makeFakeDb({ email, passwordHash }) {
  const calls = [];
  return {
    calls,
    execute: async ({ sql, args }) => {
      calls.push({ sql, args });
      if (/SELECT .* FROM users WHERE email/i.test(sql)) {
        if (args[0] === email) {
          return {
            rows: [{ id: 'user-1', email, password_hash: passwordHash }],
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe('performLogin', () => {
  const email = 'admin@agenticz.test';
  const password = 'correct horse battery staple';
  let hash;
  let db;

  beforeAll(async () => {
    hash = await auth.hashPassword(password);
  });

  beforeEach(() => {
    auth._resetRateLimiter();
    db = makeFakeDb({ email, passwordHash: hash });
  });

  it('rejects a wrong password with 401 and a generic error', async () => {
    const r = await auth.performLogin({
      email,
      password: 'wrong',
      ip: '1.2.3.4',
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toBe('Invalid email or password');
  });

  it('rejects an unknown email with 401 (no existence leak)', async () => {
    const r = await auth.performLogin({
      email: 'noone@test.example',
      password,
      ip: '1.2.3.4',
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toBe('Invalid email or password');
  });

  it('accepts correct credentials and returns a session cookie', async () => {
    const r = await auth.performLogin({
      email,
      password,
      ip: '1.2.3.4',
      db,
    });
    expect(r.ok).toBe(true);
    expect(r.user).toEqual({ email });
    expect(r.cookie).toMatch(/^agenticz_session=/);
    expect(r.cookie).toMatch(/HttpOnly/);
    expect(r.cookie).toMatch(/Secure/);
    expect(r.cookie).toMatch(/SameSite=Strict/);
    expect(r.cookie).toMatch(/Path=\//);
    expect(r.cookie).toMatch(/Max-Age=28800/);
  });

  it('normalizes email casing and whitespace', async () => {
    const r = await auth.performLogin({
      email: `  ${email.toUpperCase()}  `,
      password,
      ip: '1.2.3.4',
      db,
    });
    expect(r.ok).toBe(true);
  });

  it('returns 429 on the 6th attempt from the same IP within 5 minutes', async () => {
    const ip = '9.9.9.9';
    for (let i = 0; i < 5; i++) {
      const r = await auth.performLogin({
        email,
        password: 'wrong',
        ip,
        db,
      });
      expect(r.status).toBe(401);
    }
    const blocked = await auth.performLogin({
      email,
      password,
      ip,
      db,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.error).toMatch(/too many attempts/i);
  });

  it('tracks rate limits per IP independently', async () => {
    for (let i = 0; i < 5; i++) {
      await auth.performLogin({ email, password: 'wrong', ip: '5.5.5.5', db });
    }
    const blocked = await auth.performLogin({
      email,
      password,
      ip: '5.5.5.5',
      db,
    });
    expect(blocked.status).toBe(429);

    const ok = await auth.performLogin({
      email,
      password,
      ip: '6.6.6.6',
      db,
    });
    expect(ok.ok).toBe(true);
  });
});
