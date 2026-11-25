// Final gate #1 (demo side): the demo server's /samples/*.eml must not hand one caller unlimited fresh signed income emails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSampleLimiter, SAMPLE_PER_KEY } from '../src/sample-limit.js';
import { makeServer, makeUnderwriter } from '../../app/scripts/enclave-lib.mjs';

test('limiter: a caller gets SAMPLE_PER_KEY per window, the whole demo gets a global cap, and the window rolls', () => {
  let t = 0;
  const l = createSampleLimiter({ perKey: 3, global: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal(l.take('a').ok, true);
  const no = l.take('a');
  assert.equal(no.ok, false);
  assert.ok(no.retryAfterS >= 1);
  assert.equal(l.take('b').ok, true); // another caller is fine ...
  assert.equal(l.take('b').ok, true);
  assert.equal(l.take('c').ok, false); // ... until the global cap (5) is spent
  t = 1001;
  assert.equal(l.take('a').ok, true, 'the window rolled');
  assert.ok(SAMPLE_PER_KEY <= 10, 'the default is tiny');
});

test('demo server: the 3rd sample from one (non-loopback) caller is refused with 429; a different caller still gets one', async () => {
  const server = makeServer(makeUnderwriter(null), { samples: { exemptLoopback: false, perKey: 2, global: 50 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, h = {}) => fetch(`${base}${p}`, { headers: h });
  try {
    assert.equal((await get('/samples/deel.eml', { 'x-forwarded-for': '9.9.9.9' })).status, 200);
    assert.equal((await get('/samples/bank.eml', { 'x-forwarded-for': '9.9.9.9' })).status, 200);
    const r = await get('/samples/deel.eml', { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
    assert.equal((await get('/samples/deel.eml', { 'x-forwarded-for': '8.8.8.8' })).status, 200);
  } finally { server.close(); }
});

test('demo server: a direct loopback caller (local e2e, the developer\'s own browser) is exempt by default', async () => {
  const server = makeServer(makeUnderwriter(null), { samples: { perKey: 1, global: 1 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (let i = 0; i < 4; i++) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/samples/deel.eml`)).status, 200);
  } finally { server.close(); }
});
