import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

let wv;
beforeAll(async () => {
  wv = await import('../lib/website-voice.js');
});

function makeFakeDb() {
  const state = { stages: [] };
  return {
    state,
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*UPDATE website_voice_stages/.test(sql)) {
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
      if (/^\s*INSERT INTO website_voice_stages/.test(sql)) {
        const [id, user_id, agent_name, company_name, company_description, call_purpose, staged_at, expires_at] = args;
        state.stages.push({
          id, user_id, agent_name, company_name, company_description,
          call_purpose, staged_at, expires_at, cleared_at: null,
        });
        return { rows: [] };
      }
      if (/^\s*SELECT \* FROM website_voice_stages\s+WHERE user_id =/i.test(sql)) {
        const [userId, now] = args;
        const rows = state.stages
          .filter((s) => s.user_id === userId && s.cleared_at == null && s.expires_at > now)
          .sort((a, b) => b.staged_at - a.staged_at);
        return { rows: rows.slice(0, 1) };
      }
      if (/^\s*SELECT id FROM website_voice_stages\s+WHERE user_id =/i.test(sql)) {
        const [userId, now] = args;
        const row = state.stages.find(
          (s) => s.user_id === userId && s.cleared_at == null && s.expires_at > now,
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }
      return { rows: [] };
    }),
  };
}

const VALID = {
  agentName: 'Ava',
  companyName: 'Acme Roofing',
  companyDescription: 'We install commercial flat roofs across the UK.',
  callPurpose: 'Answer visitor questions and book follow-up meetings.',
};

describe('validateStageInput', () => {
  it('accepts a fully valid payload', () => {
    const r = wv.validateStageInput(VALID);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(VALID);
  });
  it('rejects empty input', () => {
    expect(wv.validateStageInput(null).ok).toBe(false);
    expect(wv.validateStageInput({}).ok).toBe(false);
  });
  it.each(['agentName', 'companyName', 'companyDescription', 'callPurpose'])(
    'rejects missing %s',
    (k) => {
      const r = wv.validateStageInput({ ...VALID, [k]: '' });
      expect(r.ok).toBe(false);
      expect(r.fieldErrors[k]).toMatch(/required/i);
    },
  );
  it('rejects HTML in any field', () => {
    const r = wv.validateStageInput({ ...VALID, companyName: 'Acme <script>' });
    expect(r.ok).toBe(false);
  });
});

describe('stageDemoForUser', () => {
  it('inserts a stage with 15-min expiry', async () => {
    const db = makeFakeDb();
    const now = 2_000_000_000;
    const r = await wv.stageDemoForUser({
      userId: 'user-1',
      input: VALID,
      db,
      clock: () => now,
    });
    expect(r.ok).toBe(true);
    expect(r.stage.expiresAt).toBe(now + 15 * 60 * 1000);
    expect(db.state.stages).toHaveLength(1);
  });

  it('clears the previous active stage before inserting a new one', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wv.stageDemoForUser({ userId: 'u1', input: { ...VALID, companyName: 'First' }, db, clock: () => t0 });
    const t1 = t0 + 30_000;
    await wv.stageDemoForUser({ userId: 'u1', input: { ...VALID, companyName: 'Second' }, db, clock: () => t1 });
    expect(db.state.stages[0].cleared_at).toBe(t1);
    expect(db.state.stages[1].cleared_at).toBeNull();
  });

  it('returns 401 without a userId', async () => {
    const db = makeFakeDb();
    const r = await wv.stageDemoForUser({ userId: null, input: VALID, db });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('returns 400 on invalid input', async () => {
    const db = makeFakeDb();
    const r = await wv.stageDemoForUser({
      userId: 'u1',
      input: { ...VALID, agentName: '' },
      db,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('getActiveStageForUser — expiry', () => {
  it('returns null when the stage has expired', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wv.stageDemoForUser({ userId: 'u1', input: VALID, db, clock: () => t0 });
    const later = t0 + 16 * 60 * 1000;
    const active = await wv.getActiveStageForUser({
      userId: 'u1', db, clock: () => later,
    });
    expect(active).toBeNull();
  });
  it('returns the stage while still fresh', async () => {
    const db = makeFakeDb();
    const t0 = 1_000_000;
    await wv.stageDemoForUser({ userId: 'u1', input: VALID, db, clock: () => t0 });
    const mid = t0 + 10 * 60 * 1000;
    const active = await wv.getActiveStageForUser({
      userId: 'u1', db, clock: () => mid,
    });
    expect(active).toBeTruthy();
    expect(active.companyName).toBe(VALID.companyName);
  });
});

describe('stageToDynamicVariables', () => {
  it('maps a stage to Retell dynamic variable keys', () => {
    const v = wv.stageToDynamicVariables({
      agentName: 'Ava',
      companyName: 'Acme',
      companyDescription: 'desc',
      callPurpose: 'purpose',
    });
    expect(v).toEqual({
      agent_name: 'Ava',
      company_name: 'Acme',
      company_description: 'desc',
      call_purpose: 'purpose',
    });
  });
});
