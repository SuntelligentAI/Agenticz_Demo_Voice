import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';

if (!email) throw new Error('ADMIN_EMAIL is not set');
if (!password) throw new Error('ADMIN_PASSWORD is not set');
if (password.length < 12) {
  throw new Error('ADMIN_PASSWORD must be at least 12 characters');
}

const db = getDb();
const existing = await db.execute({
  sql: 'SELECT id FROM users WHERE email = ?',
  args: [email],
});

const hash = await hashPassword(password);

if (existing.rows.length > 0) {
  await db.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
    args: [hash, email],
  });
  console.log(`Updated password for existing admin: ${email}`);
} else {
  await db.execute({
    sql: 'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    args: [randomUUID(), email, hash, Date.now()],
  });
  console.log(`Created admin user: ${email}`);
}
