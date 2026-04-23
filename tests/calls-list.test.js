import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

let calls;
beforeAll(async () => {
  calls = await import('../lib/calls.js');
});

function makeFakeDb(rows) {
  return {
    execute: vi.fn(async ({ sql, args }) => {
      const hasProductFilter = /AND product = \?/i.test(sql);
      if (/^\s*SELECT COUNT\(\*\)/i.test(sql)) {
        const [userId, product] = hasProductFilter ? args : [args[0]];
        const filtered = rows.filter(
          (r) => r.user_id === userId && (!hasProductFilter || r.product === product),
        );
        return { rows: [{ count: filtered.length }] };
      }
      if (/^\s*SELECT id, product, status, outcome/i.test(sql)) {
        let userId, product, limit, offset;
        if (hasProductFilter) {
          [userId, product, limit, offset] = args;
        } else {
          [userId, limit, offset] = args;
        }
        const sorted = rows
          .filter(
            (r) =>
              r.user_id === userId &&
              (!hasProductFilter || r.product === product),
          )
          .slice()
          .sort((a, b) => b.created_at - a.created_at);
        return { rows: sorted.slice(offset, offset + limit) };
      }
      return { rows: [] };
    }),
  };
}

function makeRow(i, userId = 'user-1', product = 'speed_to_lead') {
  return {
    id: `call-${i}`,
    user_id: userId,
    product,
    status: 'ended',
    outcome: 'completed',
    agent_name: 'Sarah',
    company_name: `Co ${i}`,
    prospect_name: `Prospect ${i}`,
    prospect_phone: '+447700900000',
    retell_call_id: `retell-${i}`,
    created_at: 1_700_000_000_000 + i * 60_000,
    started_at: null,
    ended_at: null,
    duration_seconds: i * 10,
  };
}

describe('listCallsForUser', () => {
  it('returns most-recent-first, paginates, and counts total', async () => {
    const rows = [];
    for (let i = 0; i < 25; i++) rows.push(makeRow(i));
    const db = makeFakeDb(rows);

    const page1 = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      db,
    });
    expect(page1.ok).toBe(true);
    expect(page1.data.items).toHaveLength(20);
    expect(page1.data.items[0].id).toBe('call-24');
    expect(page1.data.items[19].id).toBe('call-5');
    expect(page1.data.total).toBe(25);
    expect(page1.data.totalPages).toBe(2);
    expect(page1.data.page).toBe(1);
    expect(page1.data.limit).toBe(20);

    const page2 = await calls.listCallsForUser({
      userId: 'user-1',
      page: 2,
      limit: 20,
      db,
    });
    expect(page2.data.items).toHaveLength(5);
    expect(page2.data.items[0].id).toBe('call-4');
  });

  it('only returns the logged-in user\'s rows', async () => {
    const rows = [makeRow(1, 'user-A'), makeRow(2, 'user-B'), makeRow(3, 'user-A')];
    const db = makeFakeDb(rows);

    const a = await calls.listCallsForUser({
      userId: 'user-A',
      page: 1,
      limit: 20,
      db,
    });
    expect(a.data.items.map((x) => x.id).sort()).toEqual(['call-1', 'call-3']);
    expect(a.data.total).toBe(2);
  });

  it('clamps limit to 50 and rejects invalid page/limit values safely', async () => {
    const rows = [makeRow(1)];
    const db = makeFakeDb(rows);

    const big = await calls.listCallsForUser({
      userId: 'user-1',
      page: 0,
      limit: 999,
      db,
    });
    expect(big.data.limit).toBe(50);
    expect(big.data.page).toBe(1);

    const negative = await calls.listCallsForUser({
      userId: 'user-1',
      page: -5,
      limit: -5,
      db,
    });
    expect(negative.data.limit).toBeGreaterThan(0);
    expect(negative.data.page).toBe(1);
  });

  it('returns an empty page when there are no rows', async () => {
    const db = makeFakeDb([]);
    const r = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      db,
    });
    expect(r.data.items).toEqual([]);
    expect(r.data.total).toBe(0);
    expect(r.data.totalPages).toBe(1);
  });

  it('filters by product when supplied', async () => {
    const rows = [
      makeRow(1, 'user-1', 'speed_to_lead'),
      makeRow(2, 'user-1', 'receptionist'),
      makeRow(3, 'user-1', 'receptionist'),
      makeRow(4, 'user-1', 'speed_to_lead'),
    ];
    const db = makeFakeDb(rows);

    const stl = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      product: 'speed_to_lead',
      db,
    });
    expect(stl.data.items.map((i) => i.id).sort()).toEqual(['call-1', 'call-4']);
    expect(stl.data.product).toBe('speed_to_lead');

    const rcp = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      product: 'receptionist',
      db,
    });
    expect(rcp.data.items.map((i) => i.id).sort()).toEqual(['call-2', 'call-3']);
    expect(rcp.data.product).toBe('receptionist');
  });

  it('ignores an unknown product filter and returns all rows for the user', async () => {
    const rows = [
      makeRow(1, 'user-1', 'speed_to_lead'),
      makeRow(2, 'user-1', 'receptionist'),
    ];
    const db = makeFakeDb(rows);
    const r = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      product: 'not-a-product',
      db,
    });
    expect(r.data.items).toHaveLength(2);
    expect(r.data.product).toBeNull();
  });

  it('exposes `product` on every list row', async () => {
    const rows = [makeRow(1, 'user-1', 'receptionist')];
    const db = makeFakeDb(rows);
    const r = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      db,
    });
    expect(r.data.items[0].product).toBe('receptionist');
  });

  it('list shape omits private and post-call artefact fields', async () => {
    const db = makeFakeDb([makeRow(1)]);
    const r = await calls.listCallsForUser({
      userId: 'user-1',
      page: 1,
      limit: 20,
      db,
    });
    const item = r.data.items[0];
    expect(item).not.toHaveProperty('userId');
    expect(item).not.toHaveProperty('transcript');
    expect(item).not.toHaveProperty('recordingUrl');
    expect(item).not.toHaveProperty('aiSummary');
    expect(item).not.toHaveProperty('capturedFields');
    expect(item).not.toHaveProperty('notes');
  });
});

describe('GET /api/calls handler', () => {
  it('returns 401 when no session cookie is present', async () => {
    const { default: handler } = await import('../api/calls/index.js');
    const req = { method: 'GET', headers: {}, query: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 405 for non-GET methods', async () => {
    const { default: handler } = await import('../api/calls/index.js');
    const req = { method: 'POST', headers: {}, query: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader('Allow')).toBe('GET');
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
