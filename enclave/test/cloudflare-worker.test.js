// The Cloudflare Email Worker, run with a fake message and a fake fetch: it must forward the bytes untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../deploy/cloudflare/email-worker.js';

const env = { NOTCH_INBOUND_URL: 'https://enclave.invalid/inbound', NOTCH_INBOUND_SECRET: 's3cret' };
const message = (bytes, to = 'abcdefghij@inbox.example.test') => {
  const m = { to, rawSize: bytes.length, raw: new Response(bytes).body, rejected: null, setReject(r) { this.rejected = r; } };
  return m;
};
async function run(msg, status = 200, e = env) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status }); };
  try { await worker.email(msg, e); } finally { globalThis.fetch = realFetch; }
  return calls;
}

test('forwards the raw message byte for byte with the recipient and the shared secret', async () => {
  const bytes = Buffer.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0x00, 0xff, 0x0d, 0x0a, 0x0d, 0x0a, 0x80, 0x81]);
  const m = message(bytes);
  const [c] = await run(m);
  assert.equal(c.url, env.NOTCH_INBOUND_URL);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(Buffer.from(c.init.body), bytes);
  assert.equal(c.init.headers['x-notch-rcpt'], 'abcdefghij@inbox.example.test');
  assert.equal(c.init.headers['x-notch-inbound-secret'], 's3cret');
  assert.equal(m.rejected, null);
});

test('bounces on a 4xx answer, fails (retry) on a 5xx, bounces when unconfigured or too large', async () => {
  const m = message(Buffer.from('x'));
  await run(m, 404);
  assert.match(m.rejected, /cannot take this message \(404\)/);
  await assert.rejects(run(message(Buffer.from('x')), 502), /502/);
  const none = message(Buffer.from('x'));
  assert.equal((await run(none, 200, {})).length, 0);
  assert.match(none.rejected, /not configured/);
  const big = message(Buffer.from('x'));
  big.rawSize = 6 * 1024 * 1024;
  assert.equal((await run(big)).length, 0);
  assert.match(big.rejected, /too large/);
});
