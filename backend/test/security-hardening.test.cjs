const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Regression coverage for the 2026-10-30 hardening pass:
// - per-IP auth limiter keying
// - CORS allowlist + 403 instead of 500
// - health payload hostname redaction
// - public root no longer leaks version/uptime
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
process.env.DISABLE_ALL_EMAILS = 'true';
process.env.DISABLE_REDIS = 'true';
process.env.DISABLE_EMAIL_QUEUE = 'true';

const app = require('../dist/app.js').default;

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('auth limiter decrements for repeated attempts from the same IP', async () => {
  const remaining = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    remaining.push(Number(res.headers.get('ratelimit-remaining')));
  }
  assert.deepEqual(remaining, [9, 8, 7]);
});

test('hostile Origin is rejected with 403 and no CORS grant', async () => {
  const res = await fetch(`${base}/api/health`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await res.json();
  assert.equal(body.status, 'error');
});

test('production Vercel origin is allowed', async () => {
  const res = await fetch(`${base}/api/health`, {
    headers: { Origin: 'https://cicrinventory.vercel.app' },
  });
  assert.ok([200, 503].includes(res.status));
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    'https://cicrinventory.vercel.app'
  );
});

test('health payload does not expose Neon hostnames', async () => {
  const res = await fetch(`${base}/api/health`);
  const text = await res.text();
  assert.doesNotMatch(text, /neon\.tech/i);
  assert.doesNotMatch(text, /ep-[a-z0-9-]+/i);
});

test('public root does not expose version or uptime', async () => {
  const res = await fetch(`${base}/`);
  const body = await res.json();
  assert.equal(body.status, 'online');
  assert.equal(body.version, undefined);
  assert.equal(body.uptime, undefined);
});

test('legacy X-XSS-Protection is disabled', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-xss-protection'), '0');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
