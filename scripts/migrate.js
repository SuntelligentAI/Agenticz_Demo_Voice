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
];

const db = getDb();
for (const sql of statements) {
  await db.execute(sql);
}
console.log(
  'Migration complete: users, demo_calls, call_events tables + indexes ready.',
);
