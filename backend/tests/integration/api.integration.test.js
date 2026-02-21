const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.API_BASE_URL;

if (!BASE_URL) {
  test('integration tests skipped when API_BASE_URL is missing', { skip: true }, () => {});
} else {
  test('health endpoint returns OK', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'OK');
  });

  test('openapi document is available', async () => {
    const res = await fetch(`${BASE_URL}/openapi.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.openapi, '3.0.3');
    assert.ok(body.paths['/api/auth/login']);
  });
}
