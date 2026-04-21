import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { serialize, parse } from 'cookie';

const BCRYPT_COST = 12;
const DEFAULT_COOKIE_NAME = 'agenticz_session';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

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

export function buildSessionCookie(token) {
  return serialize(cookieName(), token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: sessionTtlSeconds(),
  });
}

export function buildClearCookie() {
  return serialize(cookieName(), '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
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

export function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// TODO: replace this in-memory limiter with Upstash Redis during Phase 6 hardening.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const _attempts = new Map();

function cleanup(now) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, list] of _attempts.entries()) {
    const filtered = list.filter((t) => t > cutoff);
    if (filtered.length === 0) _attempts.delete(ip);
    else _attempts.set(ip, filtered);
  }
}

export function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const list = (_attempts.get(ip) || []).filter((t) => t > cutoff);
  _attempts.set(ip, list);
  if (list.length >= RATE_LIMIT_MAX) {
    const retryInMs = list[0] + RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, retryInMs };
  }
  return { allowed: true };
}

export function recordAttempt(ip) {
  const list = _attempts.get(ip) || [];
  list.push(Date.now());
  _attempts.set(ip, list);
  if (_attempts.size > 1000) cleanup(Date.now());
}

export function _resetRateLimiter() {
  _attempts.clear();
}

export async function performLogin({ email, password, ip, db }) {
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many attempts, try again in 5 minutes',
    };
  }
  recordAttempt(ip);

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email ||
    !password
  ) {
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }

  const normalized = email.trim().toLowerCase();
  const result = await db.execute({
    sql: 'SELECT id, email, password_hash FROM users WHERE email = ?',
    args: [normalized],
  });
  const user = result.rows[0];

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }

  await db.execute({
    sql: 'UPDATE users SET last_login_at = ? WHERE id = ?',
    args: [Date.now(), user.id],
  });

  const token = await issueSession({ email: user.email });
  return {
    ok: true,
    cookie: buildSessionCookie(token),
    user: { email: user.email },
  };
}
