import { createHash } from 'node:crypto';

// Short, salted hash of a phone number for server-side logs.
// Uses AUTH_JWT_SECRET as the salt so hashes can't be pre-computed against a rainbow table.
export function redactPhone(phone) {
  if (typeof phone !== 'string' || !phone) return '<empty>';
  const salt = process.env.AUTH_JWT_SECRET || '';
  return createHash('sha256')
    .update(phone + salt)
    .digest('hex')
    .slice(0, 12);
}
