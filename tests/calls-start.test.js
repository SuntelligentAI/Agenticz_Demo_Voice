import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.AUTH_COOKIE_NAME = 'agenticz_session';
process.env.AUTH_SESSION_TTL_SECONDS = '28800';
// getDb() constructs a libsql client lazily, so an unreachable URL is safe as
// long as no actual query is executed. The 401 path returns before any query.
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.RETELL_API_KEY = 'test-retell-key';
process.env.RETELL_FROM_NUMBER = '+447700900001';
process.env.RETELL_AGENT_ID = 'agent_test';

const VALID_INPUT = {
  agentName: 'Sarah',
  companyName: 'Acme Roofing',
  companyDescription: 'We install commercial flat roofs across the UK.',
  callPurpose: 'Follow up on their enquiry about a warehouse roof repair.',
  prospectName: 'John',
  prospectPhone: '+447700900000',
};

function makeFakeDb() {
  const calls = [];
  let rowOnSelect = null;
  const api = {
    calls,
    _setRowOnSelect(row) {
      rowOnSelect = row;
    },
    execute: vi.fn(async ({ sql, args }) => {
      calls.push({ sql, args });
      if (/^\s*SELECT /i.test(sql)) {
        return { rows: rowOnSelect ? [rowOnSelect] : [] };
      }
      return { rows: [] };
    }),
  };
  return api;
}

function makeFakeRetell({ succeed = true, callId = 'call_retell_1' } = {}) {
  return {
    createPhoneCall: vi.fn(async () => {
      if (!succeed) throw new Error('Retell 422: invalid to_number');
      return { callId };
    }),
  };
}

let calls;

beforeAll(async () => {
  calls = await import('../lib/calls.js');
});

describe('performStartCall', () => {
  let db;
  let retell;
  const userId = 'user-1';
  const fromNumber = '+447700900001';
  const overrideAgentId = 'agent_test';

  beforeEach(() => {
    calls._resetCallRateLimiter();
    db = makeFakeDb();
    retell = makeFakeRetell();
  });

  it('happy path: inserts the row, calls Retell once, updates with retell_call_id', async () => {
    const result = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();
    expect(result.retellCallId).toBe('call_retell_1');

    expect(retell.createPhoneCall).toHaveBeenCalledTimes(1);
    const retellArgs = retell.createPhoneCall.mock.calls[0][0];
    expect(retellArgs.fromNumber).toBe(fromNumber);
    expect(retellArgs.toNumber).toBe(VALID_INPUT.prospectPhone);
    expect(retellArgs.overrideAgentId).toBe(overrideAgentId);
    expect(retellArgs.metadata).toEqual({
      demo_call_id: result.id,
      user_id: userId,
    });
    expect(retellArgs.retellLlmDynamicVariables).toEqual({
      agent_name: VALID_INPUT.agentName,
      company_name: VALID_INPUT.companyName,
      company_description: VALID_INPUT.companyDescription,
      call_purpose: VALID_INPUT.callPurpose,
      prospect_name: VALID_INPUT.prospectName,
    });

    // DB: INSERT pending, then UPDATE to dialing with retell_call_id
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.execute.mock.calls[0][0].sql).toMatch(/INSERT INTO demo_calls/);
    expect(db.execute.mock.calls[0][0].args[0]).toBe(result.id);
    expect(db.execute.mock.calls[0][0].args[1]).toBe(userId);
    expect(db.execute.mock.calls[0][0].sql).toMatch(/'pending'/);

    expect(db.execute.mock.calls[1][0].sql).toMatch(/UPDATE demo_calls/);
    expect(db.execute.mock.calls[1][0].sql).toMatch(/'dialing'/);
    expect(db.execute.mock.calls[1][0].args).toEqual(['call_retell_1', result.id]);
  });

  it('returns 400 on bad input and never hits Retell', async () => {
    const result = await calls.performStartCall({
      userId,
      input: { ...VALID_INPUT, prospectPhone: 'not-a-phone' },
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toBe('Invalid input');
    expect(retell.createPhoneCall).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns 502 and marks the row failed when Retell throws; error is not leaked', async () => {
    retell = makeFakeRetell({ succeed: false });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });
    consoleSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe('Could not place call');
    // never leaks Retell's error text
    expect(JSON.stringify(result)).not.toMatch(/invalid to_number/);
    expect(JSON.stringify(result)).not.toMatch(/422/);

    // DB: INSERT pending, then UPDATE failed
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.execute.mock.calls[1][0].sql).toMatch(/UPDATE demo_calls/);
    expect(db.execute.mock.calls[1][0].sql).toMatch(/'failed'/);
    expect(db.execute.mock.calls[1][0].sql).toMatch(/'trigger_error'/);
  });

  it('rate limits to 10 per user per 10 minutes (11th rejected)', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await calls.performStartCall({
        userId,
        input: VALID_INPUT,
        db,
        retell,
        fromNumber,
        overrideAgentId,
      });
      expect(r.ok, `attempt ${i + 1} should succeed`).toBe(true);
    }
    const blocked = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.error).toMatch(/too many/i);
  });

  it('tracks rate limits per user independently', async () => {
    for (let i = 0; i < 10; i++) {
      await calls.performStartCall({
        userId: 'userA',
        input: VALID_INPUT,
        db,
        retell,
        fromNumber,
        overrideAgentId,
      });
    }
    const blocked = await calls.performStartCall({
      userId: 'userA',
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });
    expect(blocked.status).toBe(429);

    const ok = await calls.performStartCall({
      userId: 'userB',
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });
    expect(ok.ok).toBe(true);
  });

  it('rate-limit budget is not consumed by input that fails validation', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await calls.performStartCall({
        userId,
        input: { ...VALID_INPUT, prospectPhone: 'bad' },
        db,
        retell,
        fromNumber,
        overrideAgentId,
      });
      expect(r.status).toBe(400);
    }
    const ok = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
    });
    expect(ok.ok).toBe(true);
  });

  it('block lifts after the 10-minute window (with mocked clock)', async () => {
    let now = 1_000_000;
    const clock = () => now;

    for (let i = 0; i < 10; i++) {
      await calls.performStartCall({
        userId,
        input: VALID_INPUT,
        db,
        retell,
        fromNumber,
        overrideAgentId,
        clock,
      });
    }
    const blocked = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
      clock,
    });
    expect(blocked.status).toBe(429);

    now += 10 * 60 * 1000 + 1;
    const unlocked = await calls.performStartCall({
      userId,
      input: VALID_INPUT,
      db,
      retell,
      fromNumber,
      overrideAgentId,
      clock,
    });
    expect(unlocked.ok).toBe(true);
  });
});

describe('POST /api/calls/start handler', () => {
  it('returns 401 when no session cookie is present', async () => {
    const { default: handler } = await import('../api/calls/start.js');
    const req = {
      method: 'POST',
      headers: {},
      body: VALID_INPUT,
    };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 405 for non-POST methods', async () => {
    const { default: handler } = await import('../api/calls/start.js');
    const req = { method: 'GET', headers: {}, body: {} };
    const res = createMockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader('Allow')).toBe('POST');
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
