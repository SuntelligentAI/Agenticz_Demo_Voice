import { describe, it, expect } from 'vitest';
import handler from '../api/health.js';

function createMockRes() {
  const headers = {};
  let statusCode = 0;
  let body = undefined;
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

describe('GET /api/health', () => {
  it('returns 200 with { ok: true }', async () => {
    const req = { method: 'GET', url: '/api/health', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toMatch(/application\/json/);

    const parsed =
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    expect(parsed).toEqual({ ok: true });
  });
});
