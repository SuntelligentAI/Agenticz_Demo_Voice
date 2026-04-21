import { getDb } from '../lib/db.js';

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,
];

const db = getDb();
for (const sql of statements) {
  await db.execute(sql);
}
console.log('Migration complete: users table + idx_users_email ready.');
