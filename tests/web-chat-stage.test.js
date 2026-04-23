import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

let wc;
beforeAll(async () => {
  wc = await import('../lib/web-chat.js');
});

function makeFakeDb() {
  const state = { stages: [] };
  return {
    state,
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*UPDATE web_chat_stages/.test(sql)) {
        const [clearedAt, userId, now] = args;
        let updated = 0;
        for (const s of state.stages) {
          if (s.user_id === userId && s.cleared_at == null && s.expires_at > now) {
            s.cleared_at = clearedAt;
            updated++;
          }
        }
        return { rows: [], rowsAffected: updated };
      }
      if (/^\s*INSERT INTO web_chat_stages/.test(sql)) {
        const [id, user_id, agent_name, company_name, company_description, call_purpose, staged_at, expires_at] = args;
        state.stages.push({
          id, user_id, agent_name, company_name, company_description,
          call_purpose, staged_at, expires_at, cleared_at: null,
        });
        return { rows: [] };
      }
      if (/^\s*SELECT \* FROM web_chat_stages\s+WHERE user_id =/i.test(sql)) {
        const [userId, now] = args;
        const rows = state.stages
          .filter((s) => s.user_id === userId && s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      if (/^\s*SELECT id FROM web_chat_stages\s+WHERE user_id =/i.test(sql)) {
        const [userId, now] = args;
        const row = state.stages.find(
          (s) => s.user_id === userId && s.cleared_at == null && s.expires_at > now,
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/^\s*SELECT \* FROM web_chat_stages\s+WHERE cleared_at IS NULL/i.test(sql)) {
        const [now] = args;
        const rows = state.stages
          .filter((s) => s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      return { rows: [] };
    }),
  };
}

const VALID = {
  agentName: 'Ava',
  companyName: 'Acme Roofing',
  companyDescription: 'We install commercial flat roofs across the UK.',
  callPurpose: 'Answer visitor questions and book a meeting if they like.',
};

describe('validateStageInput', () => {
  it('accepts a valid payload', () => {
    const r = wc.validateStageInput(VALID);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(VALID);
  });
  it('rejects non-objects', () => {
    expect(wc.validateStageInput(null).ok).toBe(false);
    expect(wc.validateStageInput('').ok).toBe(false);
  });
  it.each(['agentName', 'companyName', 'companyDescription', 'callPurpose'])(
    'rejects missing %s',
    (k) => {
      const r = wc.validateStageInput({ ...VALID, [k]: '' });
      expect(r.ok).toBe(false);
      expect(r.fieldErrors[k]).toMatch(/required/i);
    },
  );
  it('rejects HTML characters', () => {
    const r = wc.validateStageInput({ ...VALID, companyName: 'Acme <script>' });
    expect(r.ok).toBe(false);
  });
});

describe('stageDemoForUser', () => {
  it('inserts with 15-min expiry and clears any earlier active stage', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wc.stageDemoForUser({ userId: 'u1', input: { ...VALID, companyName: 'First' }, db, clock: () => t0 });
    const t1 = t0 + 30_000;
    const r = await wc.stageDemoForUser({
      userId: 'u1',
      input: { ...VALID, companyName: 'Second' },
      db,
      clock: () => t1,
    });
    expect(r.ok).toBe(true);
    expect(r.stage.expiresAt).toBe(t1 + 15 * 60 * 1000);
    expect(db.state.stages[0].cleared_at).toBe(t1);
    expect(db.state.stages[1].cleared_at).toBeNull();
  });

  it('returns 401 without userId', async () => {
    const r = await wc.stageDemoForUser({ userId: null, input: VALID, db: makeFakeDb() });
    expect(r.status).toBe(401);
  });

  it('returns 400 on invalid input', async () => {
    const r = await wc.stageDemoForUser({
      userId: 'u1',
      input: { ...VALID, agentName: '' },
      db: makeFakeDb(),
    });
    expect(r.status).toBe(400);
  });
});

describe('getActiveStageForUser', () => {
  it('returns null once expired', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wc.stageDemoForUser({ userId: 'u1', input: VALID, db, clock: () => t0 });
    const r = await wc.getActiveStageForUser({
      userId: 'u1',
      db,
      clock: () => t0 + 16 * 60 * 1000,
    });
    expect(r).toBeNull();
  });
  it('returns the stage while fresh', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wc.stageDemoForUser({ userId: 'u1', input: VALID, db, clock: () => t0 });
    const r = await wc.getActiveStageForUser({
      userId: 'u1',
      db,
      clock: () => t0 + 10 * 60 * 1000,
    });
    expect(r?.companyName).toBe(VALID.companyName);
  });
});

describe('getMostRecentActiveStage', () => {
  it('returns the newest stage across users', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wc.stageDemoForUser({
      userId: 'user-A',
      input: { ...VALID, companyName: 'Alpha Corp' },
      db,
      clock: () => t0,
    });
    await wc.stageDemoForUser({
      userId: 'user-B',
      input: { ...VALID, companyName: 'Beta Corp' },
      db,
      clock: () => t0 + 10,
    });
    const r = await wc.getMostRecentActiveStage({ db, clock: () => t0 + 20 });
    expect(r.companyName).toBe('Beta Corp');
  });
});

describe('stageToDynamicVariables', () => {
  it('maps to Retell dynamic variable keys', () => {
    expect(
      wc.stageToDynamicVariables({
        agentName: 'Ava',
        companyName: 'Acme',
        companyDescription: 'desc',
        callPurpose: 'purpose',
      }),
    ).toEqual({
      agent_name: 'Ava',
      company_name: 'Acme',
      company_description: 'desc',
      call_purpose: 'purpose',
    });
  });
});
