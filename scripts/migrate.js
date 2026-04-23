import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/db.js';

const statements = [
  // Phase 1 — users
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,

  // Phase 2 — demo calls
  `CREATE TABLE IF NOT EXISTS demo_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    agent_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    company_description TEXT NOT NULL,
    call_purpose TEXT NOT NULL,
    prospect_name TEXT NOT NULL,
    prospect_phone TEXT NOT NULL,
    retell_call_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    outcome TEXT,
    transcript TEXT,
    recording_url TEXT,
    ai_summary TEXT,
    captured_fields TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    duration_seconds INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_demo_calls_user ON demo_calls(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_demo_calls_retell ON demo_calls(retell_call_id)`,

  // Phase 2 — call events (webhook + Retell event log)
  `CREATE TABLE IF NOT EXISTS call_events (
    id TEXT PRIMARY KEY,
    demo_call_id TEXT NOT NULL REFERENCES demo_calls(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT,
    received_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(demo_call_id, received_at)`,

  // Phase 7 — receptionist staged context
  `CREATE TABLE IF NOT EXISTS receptionist_stages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    company_description TEXT NOT NULL,
    call_purpose TEXT NOT NULL,
    staged_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    cleared_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receptionist_stages_user_active
     ON receptionist_stages(user_id, cleared_at, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_receptionist_stages_active
     ON receptionist_stages(cleared_at, expires_at, staged_at DESC)`,

  // Phase 7 — simple key/value system settings (kill switch lives here)
  `CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  )`,

  // Phase 7 wrap-up — append-only log of every system_settings write, so we
  // can surface "auto-off" reasons in the UI without losing history.
  `CREATE TABLE IF NOT EXISTS system_settings_log (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_by TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_system_settings_log_key_created
     ON system_settings_log(key, created_at DESC)`,
];

const db = getDb();
for (const sql of statements) {
  await db.execute(sql);
}

// Phase 7 — add `product` column to demo_calls (idempotent: check first).
const cols = await db.execute({ sql: 'PRAGMA table_info(demo_calls)' });
const hasProduct = cols.rows.some((r) => r.name === 'product');
if (!hasProduct) {
  await db.execute(
    `ALTER TABLE demo_calls ADD COLUMN product TEXT NOT NULL DEFAULT 'speed_to_lead'`,
  );
  console.log("Added `product` column to demo_calls (default 'speed_to_lead').");
}

// Phase 7 — seed the kill-switch default (line starts OFF).
const now = Date.now();
await db.execute({
  sql: `INSERT OR IGNORE INTO system_settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)`,
  args: ['receptionist_line_enabled', 'false', now, 'migration'],
});

// Phase 7 — seed a sentinel "anonymous" user for inbound calls that arrive
// when no demo is staged (so demo_calls.user_id NOT NULL can be satisfied).
// This user cannot log in (password_hash is a placeholder that no bcrypt
// verify will match).
await db.execute({
  sql: `INSERT OR IGNORE INTO users (id, email, password_hash, created_at)
        VALUES (?, ?, ?, ?)`,
  args: [
    'system-anonymous',
    'anonymous@demo.local',
    '(disabled-login)',
    now,
  ],
});

console.log(
  'Migration complete: users, demo_calls(+product), call_events, receptionist_stages, system_settings ready.',
);
