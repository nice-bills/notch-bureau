// The secret pepper in the MoMo-number hash. Without it the public ["identity", id_hash] account of a line can be matched by
// hashing every possible Ghanaian number. Real servers must refuse to start without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { fileURLToPath } from 'node:url';
import { INSECURE_FLAG, MIN_PEPPER_CHARS, PepperError, cvmPepper, pepperFromDstack, requirePepper } from '../src/pepper.js';
import { identityHash, normalizeMsisdn } from '../src/statement.js';
import { assertPepperSafe, composeText } from '../../deploy/phala/build-compose.mjs';
import { Underwriter } from '../src/underwriter.js';
import { InboxedUnderwriter } from './fixtures/inboxed.js';
import { resolver, momoStatementEmail, randomMsisdn, syntheticRows } from './fixtures/emails.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const enclave = path.resolve(here, '..');
const GOOD = crypto.randomBytes(32).toString('hex');

test('requirePepper: a long secret passes; none, or a short one, refuses', () => {
  assert.equal(requirePepper({ NOTCH_ID_PEPPER: GOOD }), GOOD);
  assert.throws(() => requirePepper({}), (e) => e instanceof PepperError && /NOTCH_ID_PEPPER is not set/.test(e.message));
  assert.throws(() => requirePepper({ NOTCH_ID_PEPPER: 'secret' }), /too short/);
  assert.throws(() => requirePepper({ NOTCH_ID_PEPPER: 'x'.repeat(MIN_PEPPER_CHARS - 1) }), /too short/);
  assert.equal(requirePepper({ NOTCH_ID_PEPPER: 'x'.repeat(MIN_PEPPER_CHARS) }), 'x'.repeat(MIN_PEPPER_CHARS));
});

test('the insecure flag is explicit (exactly "1"), returns no pepper, and warns loudly every time', () => {
  const said = [];
  assert.equal(requirePepper({ [INSECURE_FLAG]: '1' }, { warn: (m) => said.push(m) }), '');
  assert.equal(said.length, 1);
  assert.match(said[0], /WARNING/);
  assert.match(said[0], /brute-forced/);
  assert.throws(() => requirePepper({ [INSECURE_FLAG]: 'true' }), PepperError);
  assert.throws(() => requirePepper({ [INSECURE_FLAG]: '0' }), PepperError);
  // a real pepper wins over the flag and prints nothing
  const quiet = [];
  assert.equal(requirePepper({ NOTCH_ID_PEPPER: GOOD, [INSECURE_FLAG]: '1' }, { warn: (m) => quiet.push(m) }), GOOD);
  assert.equal(quiet.length, 0);
});

test('the pepper really changes the hash: the unpeppered hash of a number cannot be matched without it', () => {
  const n = normalizeMsisdn('024 123 4567');
  const open = identityHash(n);
  const peppered = identityHash(n, GOOD);
  assert.notDeepEqual(open, peppered);
  assert.notDeepEqual(identityHash(n, crypto.randomBytes(32).toString('hex')), peppered);
  // an observer who hashes every number (no pepper) never lands on the peppered hash
  const seen = new Set(); for (let i = 0; i < 2000; i++) seen.add(identityHash(`23324${String(i).padStart(7, '0')}`).toString('hex'));
  assert.ok(!seen.has(peppered.toString('hex')));
});

test('an Underwriter with a pepper puts the peppered hash in the record, not the guessable one', async () => {
  const msisdn = randomMsisdn();
  const mk = (idPepper) => new InboxedUnderwriter({ resolver, llm: null, idPepper });
  const rows = syntheticRows();
  const run = async (u) => {
    const w = bs58.encode(nacl.sign.keyPair().publicKey);
    const r = await u.submit(await momoStatementEmail({ msisdn, rows: rows.map((x, i) => ({ ...x, txid: `9${crypto.randomInt(1e9, 9e9)}${i}` })) }), w);
    assert.equal(r.ok, true, r.reason);
    return Buffer.from(r.message, 'base64').subarray(96, 128);
  };
  const withPepper = await run(mk(GOOD));
  const without = await run(mk(''));
  const n = normalizeMsisdn(msisdn);
  assert.deepEqual(withPepper, identityHash(n, GOOD));
  assert.deepEqual(without, identityHash(n));
  assert.notDeepEqual(withPepper, identityHash(n), 'the peppered record is not the brute-forceable hash');
});

// ---- dstack: the CVM derives the pepper inside the TEE ----------------------------------------------------------------

const dstackClient = (keyHex, calls = []) => ({ getKey: async (p, purpose) => { calls.push([p, purpose]); return { key: keyHex, signature_chain: [] }; } });
const broken = (msg) => ({ getKey: async () => { throw new Error(msg); } });

test('pepperFromDstack: deterministic per dstack key, different keys give different peppers, v0 failing falls back to v1', async () => {
  const k1 = crypto.randomBytes(32).toString('hex');
  const k2 = crypto.randomBytes(32).toString('hex');
  const calls = [];
  const a = await pepperFromDstack([dstackClient(k1, calls)]);
  assert.equal(a, await pepperFromDstack([dstackClient(k1)]), 'same key, same pepper: stable across restarts');
  assert.notEqual(a, await pepperFromDstack([dstackClient(k2)]));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(a.length >= MIN_PEPPER_CHARS);
  assert.notEqual(a, k1, 'the raw dstack key is never itself the pepper');
  assert.deepEqual(calls[0], ['notch/id-pepper/v1', 'notch-id-pepper'], 'a path of its own, not the signing key\'s');
  assert.equal(await pepperFromDstack([broken('v0 route missing'), dstackClient(k1)]), a);
  await assert.rejects(pepperFromDstack([broken('no socket'), broken('no socket')]), /could not derive the identity pepper inside the TEE/);
  await assert.rejects(pepperFromDstack([dstackClient('abcd')]), /short key/);
});

test('cvmPepper: derives in the TEE and ignores an operator-supplied NOTCH_ID_PEPPER; refuses without dstack unless the test flag', async () => {
  const k = crypto.randomBytes(32).toString('hex');
  const said = [];
  const warn = (m) => said.push(m);
  const derived = await cvmPepper({ NOTCH_ID_PEPPER: GOOD }, () => [dstackClient(k)], { warn });
  assert.equal(derived, await pepperFromDstack([dstackClient(k)]));
  assert.notEqual(derived, GOOD, 'an env pepper is not used inside the CVM');
  assert.ok(said.some((m) => /ignored inside the CVM/.test(m)));
  await assert.rejects(cvmPepper({}, () => [broken('no socket')], { warn }), /refusing to start/);
  await assert.rejects(cvmPepper({ NOTCH_ID_PEPPER: GOOD }, () => [broken('no socket')], { warn }), /refusing to start/, 'no silent fallback to an env value');
  const loud = []; await assert.rejects(cvmPepper({ [INSECURE_FLAG]: '1' }, () => [broken('no socket')], { warn: (m) => loud.push(m) }), /refusing to start/, 'the insecure flag never works inside the CVM');
  assert.match(loud[0], /ignored inside the CVM/);
});

test('the Phala compose never carries a pepper or the insecure switch, and the build refuses if someone adds one', () => {
  assertPepperSafe();
  assert.throws(() => assertPepperSafe({ NOTCH_ID_PEPPER: 'x' }, []), /derived inside the TEE/);
  assert.throws(() => assertPepperSafe({}, ['NOTCH_ID_PEPPER']), /derived inside the TEE/);
  assert.throws(() => assertPepperSafe({ NOTCH_INSECURE_NO_PEPPER: '1' }, []), /must not be in the compose file/);
  const text = composeText();
  assert.ok(!/NOTCH_ID_PEPPER|NOTCH_INSECURE_NO_PEPPER/.test(text.replace(/NOTCH_BUNDLE(_\d+)?: "[^"]*"/g, '')), 'neither name is an env value of the compose file');
  // the bundle (code the CVM runs) contains the derivation and the server wiring
  const src = fs.readFileSync(path.join(enclave, 'src/cvm-server.js'), 'utf8');
  assert.match(src, /cvmPepper\(process\.env/);
  assert.match(src, /idPepper,\n\s*llm,/);
});

// ---- the real servers refuse to start ---------------------------------------------------------------------------------

function run(file, env, { wait = 8000, killOn } = {}) {
  return new Promise((resolve) => {
    const clean = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env };
    const p = spawn(process.execPath, [file], { env: clean, cwd: os.tmpdir() });
    let out = '';
    const done = (code) => { clearTimeout(t); resolve({ code, out }); };
    const t = setTimeout(() => { p.kill(); }, wait);
    p.stdout.on('data', (d) => { out += d; if (killOn && killOn.test(out)) p.kill(); });
    p.stderr.on('data', (d) => { out += d; if (killOn && killOn.test(out)) p.kill(); });
    p.on('exit', (c) => done(c));
  });
}
const keyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notch-pepper-')), 'key.json');

test('enclave/src/server.js refuses to start without NOTCH_ID_PEPPER (exit 1, says why, never listens)', async () => {
  const r = await run(path.join(enclave, 'src/server.js'), { PORT: '0', NOTCH_KEY_FILE: keyFile() });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTCH_ID_PEPPER is not set/);
  assert.doesNotMatch(r.out, /on :/);
  const short = await run(path.join(enclave, 'src/server.js'), { PORT: '0', NOTCH_KEY_FILE: keyFile(), NOTCH_ID_PEPPER: 'short' });
  assert.equal(short.code, 1, short.out);
  assert.match(short.out, /too short/);
});

test('enclave/src/server.js starts with a real pepper, and with the insecure flag only with a loud warning', async () => {
  const ok = await run(path.join(enclave, 'src/server.js'), { PORT: '0', NOTCH_KEY_FILE: keyFile(), NOTCH_ID_PEPPER: GOOD }, { killOn: /notch underwriter/ });
  assert.match(ok.out, /notch underwriter/);
  assert.doesNotMatch(ok.out, /WARNING/);
  assert.ok(!ok.out.includes(GOOD), 'the pepper is never printed');
  const loud = await run(path.join(enclave, 'src/server.js'), { PORT: '0', NOTCH_KEY_FILE: keyFile(), [INSECURE_FLAG]: '1' }, { killOn: /notch underwriter/ });
  assert.match(loud.out, /WARNING: NOTCH_INSECURE_NO_PEPPER=1/);
  assert.match(loud.out, /notch underwriter/);
});

test('app/scripts/demo-enclave.mjs refuses to start without a pepper, before it writes anything', async () => {
  const samples = path.resolve(enclave, '../app/public/samples');
  const before = fs.existsSync(samples) ? fs.readdirSync(samples).map((f) => [f, fs.statSync(path.join(samples, f)).mtimeMs]) : [];
  const r = await run(path.resolve(enclave, '../app/scripts/demo-enclave.mjs'), { PORT: '0' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTCH_ID_PEPPER is not set/);
  const after = fs.existsSync(samples) ? fs.readdirSync(samples).map((f) => [f, fs.statSync(path.join(samples, f)).mtimeMs]) : [];
  assert.deepEqual(after, before, 'no sample file was touched');
});
