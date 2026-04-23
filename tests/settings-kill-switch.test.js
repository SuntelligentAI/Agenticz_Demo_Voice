import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.AUTH_JWT_SECRET =
  'test-secret-that-is-long-enough-for-hs256-signing-in-the-test-suite';
process.env.TURSO_DATABASE_URL = 'http://127.0.0.1:1';
process.env.TURSO_AUTH_TOKEN = 'test-token';

let settings;
beforeAll(async () => {
  settings = await import('../lib/settings.js');
});

function makeFakeDb() {
  const store = new Map();
  return {
    store,
    execute: vi.fn(async ({ sql, args }) => {
      if (/^\s*SELECT value FROM system_settings WHERE key/i.test(sql)) {
        const v = store.get(args[0]);
        return { rows: v == null ? [] : [{ value: v }] };
      }
      if (/^\s*INSERT INTO system_settings_log/.test(sql)) {
        // args: [id, key, value, updated_by, reason, created_at]
        return { rows: [] };
      }
      if (/^\s*INSERT INTO system_settings\b/.test(sql)) {
        // args: [key, value, updated_at, updated_by]
        store.set(args[0], args[1]);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe('kill switch (system_settings)', () => {
  it('defaults to false when nothing is stored', async () => {
    const db = makeFakeDb();
    const enabled = await settings.isReceptionistLineEnabled(db);
    expect(enabled).toBe(false);
  });

  it('stores true/false consistently', async () => {
    const db = makeFakeDb();
    await settings.setReceptionistLineEnabled(db, true, 'user@example.com');
    expect(await settings.isReceptionistLineEnabled(db)).toBe(true);
    await settings.setReceptionistLineEnabled(db, false, 'user@example.com');
    expect(await settings.isReceptionistLineEnabled(db)).toBe(false);
  });

  it('persists the value via upsert — readback returns the last write', async () => {
    const db = makeFakeDb();
    await settings.setSetting(db, 'foo', 'bar', 'me');
    expect(await settings.getSetting(db, 'foo')).toBe('bar');
    await settings.setSetting(db, 'foo', 'baz', 'me');
    expect(await settings.getSetting(db, 'foo')).toBe('baz');
  });

  it('returns the provided defaultValue when key is missing', async () => {
    const db = makeFakeDb();
    expect(await settings.getSetting(db, 'nope', 'fallback')).toBe('fallback');
  });
});
