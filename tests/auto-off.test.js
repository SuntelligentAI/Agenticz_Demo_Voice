import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

let autoOff;
let settings;
beforeAll(async () => {
  autoOff = await import('../lib/auto-off.js');
  settings = await import('../lib/settings.js');
});

function makeFakeDb({ enabled = 'false', updatedAt = 0, stages = [] } = {}) {
  const state = {
    settings: new Map([
      ['receptionist_line_enabled', enabled],
    ]),
    settingsUpdatedAt: new Map([
      ['receptionist_line_enabled', updatedAt],
    ]),
    stages: [...stages],
    logs: [],
  };
  const api = {
    state,
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT value FROM system_settings WHERE key/i.test(sql)) {
        const v = state.settings.get(args[0]);
        return { rows: v == null ? [] : [{ value: v }] };
      }
      if (/^\s*SELECT updated_at FROM system_settings WHERE key/i.test(sql)) {
        const v = state.settingsUpdatedAt.get(args[0]);
        return { rows: v == null ? [] : [{ updated_at: v }] };
      }
      if (/^\s*SELECT MAX\(staged_at\) AS latest_staged/i.test(sql)) {
        const latestStaged = state.stages.reduce(
          (m, s) => Math.max(m, s.staged_at || 0),
          0,
        );
        const latestCleared = state.stages.reduce(
          (m, s) => Math.max(m, s.cleared_at || 0),
          0,
        );
        return {
          rows: [{ latest_staged: latestStaged, latest_cleared: latestCleared }],
        };
      }
      if (/^\s*INSERT INTO system_settings_log/i.test(sql)) {
        // args: [id, key, value, updated_by, reason, created_at]
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
        // args: [key, value, updated_at, updated_by]
        state.settings.set(args[0], args[1]);
        state.settingsUpdatedAt.set(args[0], args[2]);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return api;
}

describe('maybeAutoOffLine', () => {
  beforeEach(() => {
    delete process.env.RECEPTIONIST_IDLE_THRESHOLD_MS;
  });

  it('is a no-op when the line is already off', async () => {
    const db = makeFakeDb({ enabled: 'false' });
    const now = 1_000_000_000_000;
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(false);
    expect(db.state.logs).toHaveLength(0);
  });

  it('is a no-op when the line was turned on less than 30 min ago', async () => {
    const now = 1_000_000_000_000;
    const db = makeFakeDb({
      enabled: 'true',
      updatedAt: now - 15 * 60 * 1000,
    });
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(false);
    expect(db.state.settings.get('receptionist_line_enabled')).toBe('true');
  });

  it('is a no-op when recent stage activity keeps the line alive', async () => {
    const now = 1_000_000_000_000;
    const db = makeFakeDb({
      enabled: 'true',
      updatedAt: now - 60 * 60 * 1000,
      stages: [
        {
          staged_at: now - 10 * 60 * 1000,
          cleared_at: null,
        },
      ],
    });
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(false);
    expect(db.state.settings.get('receptionist_line_enabled')).toBe('true');
  });

  it('flips off when line has been on >30 min with no stage activity', async () => {
    const now = 1_000_000_000_000;
    const db = makeFakeDb({
      enabled: 'true',
      updatedAt: now - 31 * 60 * 1000,
      stages: [],
    });
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(true);
    expect(r.reason).toBe('auto_off:idle_30min');
    expect(db.state.settings.get('receptionist_line_enabled')).toBe('false');
    const log = db.state.logs.at(-1);
    expect(log.reason).toBe('auto_off:idle_30min');
    expect(log.updated_by).toBe('system');
  });

  it('respects RECEPTIONIST_IDLE_THRESHOLD_MS override (for testing)', async () => {
    process.env.RECEPTIONIST_IDLE_THRESHOLD_MS = '60000'; // 1 min
    const now = 1_000_000_000_000;
    const db = makeFakeDb({
      enabled: 'true',
      updatedAt: now - 70 * 1000, // 70s ago
      stages: [],
    });
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(true);
  });

  it('treats a cleared stage as activity', async () => {
    const now = 1_000_000_000_000;
    const db = makeFakeDb({
      enabled: 'true',
      updatedAt: now - 60 * 60 * 1000,
      stages: [
        {
          staged_at: now - 120 * 60 * 1000,
          cleared_at: now - 5 * 60 * 1000,
        },
      ],
    });
    const r = await autoOff.maybeAutoOffLine({ db, clock: () => now });
    expect(r.flipped).toBe(false);
  });
});

describe('system_settings_log (via setSetting)', () => {
  it('appends a log entry on every write including the reason', async () => {
    const db = makeFakeDb();
    await settings.setReceptionistLineEnabled(db, true, 'gs@example.com', 'manual_on');
    await settings.setReceptionistLineEnabled(db, false, 'gs@example.com', 'manual_off');
    expect(db.state.logs).toHaveLength(2);
    expect(db.state.logs[0]).toMatchObject({
      key: 'receptionist_line_enabled',
      value: 'true',
      reason: 'manual_on',
      updated_by: 'gs@example.com',
    });
    expect(db.state.logs[1]).toMatchObject({
      value: 'false',
      reason: 'manual_off',
    });
  });
});

describe('getLatestLogEntry', () => {
  it('returns the most recent log entry for a key', async () => {
    const rows = [
      { value: 'true', updated_by: 'a', reason: 'manual_on', created_at: 1 },
      { value: 'false', updated_by: 'b', reason: 'auto_off:logout', created_at: 2 },
    ];
    const db = {
      execute: vi.fn(async ({ sql }) => {
        if (/^\s*SELECT value, updated_by, reason, created_at/i.test(sql)) {
          // Simulate ORDER BY created_at DESC LIMIT 1
          return { rows: [rows[rows.length - 1]] };
        }
        return { rows: [] };
      }),
    };
    const latest = await settings.getLatestLogEntry(db, 'receptionist_line_enabled');
    expect(latest).toEqual({
      value: 'false',
      updatedBy: 'b',
      reason: 'auto_off:logout',
      createdAt: 2,
    });
  });
});
