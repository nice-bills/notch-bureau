import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackResolver, verifyEmail } from '../src/dkim.js';

const timeout = async () => { throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }); };
const doh = (body) => async () => ({ ok: true, json: async () => body });

test('falls back to DNS over HTTPS when plain DNS times out, following the CNAME answer', async () => {
  const got = await fallbackResolver('s._domainkey.x.test', 'TXT', {
    system: timeout,
    fetchImpl: doh({ Status: 0, Answer: [{ type: 5, data: 'other.test.' }, { type: 16, data: '"v=DKIM1; k=rsa; " "p=AB\\"C"' }] }),
  });
  assert.deepEqual(got, [['v=DKIM1; k=rsa; ', 'p=AB"C']]);
});

test('a real "no such record" from plain DNS is final, not retried over HTTPS', async () => {
  let fetched = false;
  await assert.rejects(fallbackResolver('a.test', 'TXT', { system: async () => { throw Object.assign(new Error('n'), { code: 'ENOTFOUND' }); }, fetchImpl: async () => { fetched = true; } }), { code: 'ENOTFOUND' });
  assert.equal(fetched, false);
});

test('NXDOMAIN over HTTPS is reported as not found', async () => {
  await assert.rejects(fallbackResolver('a.test', 'TXT', { system: timeout, fetchImpl: doh({ Status: 3 }) }), { code: 'ENOTFOUND' });
});

test('a key lookup that fails everywhere is a retry, not a refusal', async () => {
  const eml = Buffer.from('DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=mtn.com; s=s1; h=from:subject; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=AAAA\r\nFrom: a@mtn.com\r\nSubject: x\r\n\r\n');
  const v = await verifyEmail(eml, { trusted: ['mtn.com'], resolver: timeout });
  assert.equal(v.ok, false);
  assert.equal(v.retry, true);
});
