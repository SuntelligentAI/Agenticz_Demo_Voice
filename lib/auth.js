import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { serialize, parse } from 'cookie';

const BCRYPT_COST = 12;
const DEFAULT_COOKIE_NAME = 'agenticz_session';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

// Where the login flow lands when no explicit `next` is supplied (or when the
// supplied `next` is rejected as unsafe). The gated live-demo dashboard.
export const DEFAULT_POST_LOGIN_PATH = '/voice/speed-to-lead/live';

// Allow only same-origin absolute paths. Reject protocol-relative URLs
// (`//evil.com`), anything not starting with `/`, and anything containing
// a double-slash anywhere, a backslash, whitespace, or a control char.
export function sanitizeNext(next) {
  if (typeof next !== 'string' || !next) return DEFAULT_POST_LOGIN_PATH;
  if (next.length > 512) return DEFAULT_POST_LOGIN_PATH;
  if (!next.startsWith('/')) return DEFAULT_POST_LOGIN_PATH;
  if (next.includes('//')) return DEFAULT_POST_LOGIN_PATH;
  if (next.includes('\\')) return DEFAULT_POST_LOGIN_PATH;
  if (/[\s\x00-\x1F\x7F]/.test(next)) return DEFAULT_POST_LOGIN_PATH;
  return next;
}

function getSecret() {
  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw) throw new Error('AUTH_JWT_SECRET is not set');
  return new TextEncoder().encode(raw);
}

function cookieName() {
  return process.env.AUTH_COOKIE_NAME || DEFAULT_COOKIE_NAME;
}

function sessionTtlSeconds() {
  const n = Number(process.env.AUTH_SESSION_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_SECONDS;
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

let _dummyHash;
async function getDummyHash() {
  if (!_dummyHash) {
    _dummyHash = await bcrypt.hash('agenticz-dummy-timing-value', BCRYPT_COST);
  }
  return _dummyHash;
}

export async function issueSession({ email }) {
  const ttl = sessionTtlSeconds();
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(getSecret());
}

export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

// Scope the session cookie to the apex .agenticz.io so it's valid across
// demo.agenticz.io, talentsift.agenticz.io, and any future subdomain. The
// leading dot is significant: it tells the browser to include the cookie
// on every subdomain, not just the exact host that set it.
const COOKIE_DOMAIN = '.agenticz.io';

export function buildSessionCookie(token) {
  return serialize(cookieName(), token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    domain: COOKIE_DOMAIN,
    maxAge: sessionTtlSeconds(),
  });
}

export function buildClearCookie() {
  return serialize(cookieName(), '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    domain: COOKIE_DOMAIN,
    maxAge: 0,
  });
}

export async function getSessionFromReq(req) {
  const cookieHeader = req.headers?.cookie || '';
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  const token = cookies[cookieName()];
  if (!token) return null;
  return verifySession(token);
}

export async function getSessionUser(req, db) {
  const session = await getSessionFromReq(req);
  if (!session?.email) return null;
  const email = String(session.email).trim().toLowerCase();
  if (!email) return null;
  const result = await db.execute({
    sql: 'SELECT id, email FROM users WHERE email = ?',
    args: [email],
  });
  return result.rows[0] || null;
}

export function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Rate limiter: 5 failed logins per IP in a 5-minute rolling window.
// Successful logins clear the counter for that IP.
// TODO: In-memory limiter is fine for single-instance demo. Replace with
// Upstash Redis in Phase 6 hardening — Vercel can spin up multiple instances,
// each with its own counter.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const CLEANUP_THRESHOLD = 1000;
const _attempts = new Map();

const defaultClock = () => Date.now();

export function checkRateLimit(ip, now = defaultClock()) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = _attempts.get(ip) || [];
  const list = existing.filter((t) => t > cutoff);
  if (list.length === 0) {
    _attempts.delete(ip);
  } else if (list.length !== existing.length) {
    _attempts.set(ip, list);
  }
  if (list.length >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryInMs: list[0] + RATE_LIMIT_WINDOW_MS - now,
    };
  }
  return { allowed: true };
}

export function recordFailure(ip, now = defaultClock()) {
  const list = _attempts.get(ip) || [];
  list.push(now);
  _attempts.set(ip, list);
}

export function clearFailures(ip) {
  _attempts.delete(ip);
}

export function cleanupRateLimiter(now = defaultClock()) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, list] of _attempts.entries()) {
    const filtered = list.filter((t) => t > cutoff);
    if (filtered.length === 0) _attempts.delete(ip);
    else if (filtered.length !== list.length) _attempts.set(ip, filtered);
  }
}

export function _resetRateLimiter() {
  _attempts.clear();
}

export function _rateLimiterSize() {
  return _attempts.size;
}

export async function performLogin({
  email,
  password,
  ip,
  db,
  clock = defaultClock,
}) {
  const now = clock();

  const rate = checkRateLimit(ip, now);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many attempts, try again in 5 minutes',
    };
  }

  const fail = () => {
    recordFailure(ip, now);
    if (_attempts.size > CLEANUP_THRESHOLD) cleanupRateLimiter(now);
    return { ok: false, status: 401, error: 'Invalid email or password' };
  };

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email ||
    !password
  ) {
    return fail();
  }

  const normalized = email.trim().toLowerCase();
  const result = await db.execute({
    sql: 'SELECT id, email, password_hash FROM users WHERE email = ?',
    args: [normalized],
  });
  const user = result.rows[0];

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return fail();
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return fail();
  }

  clearFailures(ip);

  await db.execute({
    sql: 'UPDATE users SET last_login_at = ? WHERE id = ?',
    args: [now, user.id],
  });

  const token = await issueSession({ email: user.email });
  return {
    ok: true,
    cookie: buildSessionCookie(token),
    user: { email: user.email },
  };
}
