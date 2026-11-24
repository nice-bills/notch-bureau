import { test } from 'node:test';
import nacl from '/home/bills/code/dev3pack/notch/enclave/node_modules/tweetnacl/nacl-fast.js'; import bs58 from '/home/bills/code/dev3pack/notch/enclave/node_modules/bs58/src/esm/index.js';
import { Underwriter } from '/home/bills/code/dev3pack/notch/enclave/src/underwriter.js';
import { resolver, momoStatementEmail } from '/home/bills/code/dev3pack/notch/enclave/test/fixtures/emails.js';
test('a statement addressed to someone else is accepted on /underwrite (no recipient) for any wallet', async () => {
  const eml = await momoStatementEmail({});
  const u = new Underwriter({ resolver, llm: null, now: () => new Date('2026-11-23T12:00:00Z') });
  const attacker = bs58.encode(nacl.sign.keyPair().publicKey);
  const r = await u.submit(eml, attacker); // what POST /underwrite does: no recipient, no wallet proof
  console.log('accepted for attacker wallet:', r.ok, r.reason || '', 'limit', r.limitUsdc);
  const withTo = await new Underwriter({ resolver, llm: null, now: () => new Date('2026-11-23T12:00:00Z') }).submit(eml, attacker, { recipient: 'attacker@inbox.notch.invalid' });
  console.log('same email with inbox To-check:', withTo.ok, withTo.reason);
});
