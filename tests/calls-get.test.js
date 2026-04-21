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

function makeFakeDb(rows = []) {
  return {
    execute: vi.fn(async ({ sql, args }) => {
      if (/SELECT \* FROM demo_calls WHERE id = \? AND user_id = \?/.test(sql)) {
        const [id, userId] = args;
        const match = rows.find(
          (r) => r.id === id && r.user_id === userId,
        );
        return { rows: match ? [match] : [] };
      }
      return { rows: [] };
    }),
  };
}

describe('getCallForUser', () => {
  it('returns 404 when the row does not exist', async () => {
    const db = makeFakeDb([]);
    const r = await calls.getCallForUser({
      callId: 'does-not-exist',
      userId: 'user-1',
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 404 when the row exists but is owned by a different user', async () => {
    const db = makeFakeDb([
      {
        id: 'call-1',
        user_id: 'user-OTHER',
        agent_name: 'Sarah',
        company_name: 'X',
        company_description: 'x'.repeat(20),
        call_purpose: 'y'.repeat(20),
        prospect_name: 'Jane',
        prospect_phone: '+447700900000',
        retell_call_id: 'retell-1',
        status: 'dialing',
        outcome: null,
        transcript: null,
        recording_url: null,
        ai_summary: null,
        captured_fields: null,
        notes: null,
        created_at: 1_000_000,
        started_at: null,
        ended_at: null,
        duration_seconds: null,
      },
    ]);
    const r = await calls.getCallForUser({
      callId: 'call-1',
      userId: 'user-ME',
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 200 with camel-cased row when owned by the session user', async () => {
    const db = makeFakeDb([
      {
        id: 'call-1',
        user_id: 'user-1',
        agent_name: 'Sarah',
        company_name: 'Acme Roofing',
        company_description: 'We install commercial flat roofs across the UK.',
        call_purpose: 'Follow up on their enquiry.',
        prospect_name: 'John',
        prospect_phone: '+447700900000',
        retell_call_id: 'retell-abc',
        status: 'dialing',
        outcome: null,
        transcript: null,
        recording_url: null,
        ai_summary: null,
        captured_fields: null,
        notes: null,
        created_at: 1_700_000_000_000,
        started_at: null,
        ended_at: null,
        duration_seconds: null,
      },
    ]);
    const r = await calls.getCallForUser({
      callId: 'call-1',
      userId: 'user-1',
      db,
    });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      id: 'call-1',
      userId: 'user-1',
      agentName: 'Sarah',
      companyName: 'Acme Roofing',
      companyDescription: 'We install commercial flat roofs across the UK.',
      callPurpose: 'Follow up on their enquiry.',
      prospectName: 'John',
      prospectPhone: '+447700900000',
      retellCallId: 'retell-abc',
      status: 'dialing',
      outcome: null,
      transcript: null,
      recordingUrl: null,
      aiSummary: null,
      capturedFields: null,
      notes: null,
      createdAt: 1_700_000_000_000,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
    });
  });

  it('returns 404 when callId is missing', async () => {
    const db = makeFakeDb([]);
    const r = await calls.getCallForUser({
      callId: undefined,
      userId: 'user-1',
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('GET /api/calls/:id handler', () => {
  it('returns 401 when no session cookie is present', async () => {
    const { default: handler } = await import('../api/calls/[id].js');
    const req = { method: 'GET', headers: {}, query: { id: 'call-1' } };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 405 for non-GET methods', async () => {
    const { default: handler } = await import('../api/calls/[id].js');
    const req = { method: 'POST', headers: {}, query: { id: 'call-1' } };
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
