// /posted must recognise BOTH record shapes (v2, 128 bytes; v3, 160 bytes with the device hash) and hash the WHOLE signed
// record, the same bytes the inbox stored with recordSha256(). A v3 record read as a 128 byte v2 prefix would hash to
// something nothing ever stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ED25519_PROGRAM, GENESIS, signedMessageOf, verifyPostedTx } from '../src/chain-posted.js';
import { RECORD_LEN, RECORD_LEN_V3, encodeRecord } from '../src/record.js';
import { recordSha256 } from '../src/store.js';
import { ed25519Data } from './fixtures/ed25519.js';

const PROGRAM = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const rec = (extra = {}) => encodeRecord({ wallet: wallet(), limitUsdc: 40, expiry: 2_000_000_000, dedupe: crypto.randomBytes(32), nonce: 5, idHash: crypto.randomBytes(32), ...extra });

function chain(edData, { genesis = GENESIS.devnet, extraIxs = [] } = {}) {
  const tx = { meta: { err: null }, transaction: { message: { accountKeys: ['payer', ED25519_PROGRAM, PROGRAM], instructions: [{ programIdIndex: 1, data: bs58.encode(edData) }, { programIdIndex: 2, data: bs58.encode(Buffer.from('x')) }, ...extraIxs] } } };
  return async (method) => (method === 'getGenesisHash' ? genesis : method === 'getTransaction' ? tx : null);
}
const SIG = '4'.repeat(88);
const verify = (rpc) => verifyPostedTx(rpc, { signature: SIG, programId: PROGRAM });

test('v2 record (128 bytes): hash of the whole record, version 2, the wallet', async () => {
  const r = rec();
  assert.equal(r.length, RECORD_LEN);
  const v = await verify(chain(ed25519Data(r)));
  assert.equal(v.version, 2);
  assert.equal(v.recordSha256, crypto.createHash('sha256').update(r).digest('hex'));
  assert.equal(v.recordSha256, recordSha256(r.toString('base64')));
  assert.equal(v.wallet, bs58.encode(r.subarray(8, 40)));
  assert.equal(v.cluster, 'devnet');
});

test('v3 record (160 bytes, device bound): hash of ALL 160 bytes, version 3, matches what the store saved', async () => {
  const r = rec({ deviceHash: crypto.randomBytes(32) });
  assert.equal(r.length, RECORD_LEN_V3);
  const v = await verify(chain(ed25519Data(r)));
  assert.equal(v.version, 3);
  assert.equal(v.recordSha256, recordSha256(r.toString('base64')), 'the same digest the inbox stored');
  assert.notEqual(v.recordSha256, crypto.createHash('sha256').update(r.subarray(0, RECORD_LEN)).digest('hex'), 'not the hash of the 128 byte prefix');
  assert.equal(v.wallet, bs58.encode(r.subarray(8, 40)));
});

test('the message is read by the instruction\'s own offsets, never by searching for a tag', async () => {
  const r = rec();
  // junk shaped like a record elsewhere in the instruction, real message is something else entirely
  const decoy = ed25519Data(Buffer.from('not a notch record, just some bytes'));
  await assert.rejects(verify(chain(Buffer.concat([decoy, r]))), /no Notch record/);
  // wrong lengths: a v2 tag with 160 bytes, a v3 tag with 128 bytes, a cut-off record
  const v2 = rec(); const v3 = rec({ deviceHash: crypto.randomBytes(32) });
  assert.equal(signedMessageOf(ed25519Data(Buffer.concat([v2, Buffer.alloc(32)]))), null);
  assert.equal(signedMessageOf(ed25519Data(v3.subarray(0, 128))), null);
  assert.equal(signedMessageOf(ed25519Data(v3.subarray(0, 150))), null);
  // the message must be inside this instruction, one signature only
  assert.equal(signedMessageOf(ed25519Data(v2, { msgIx: 1 })), null);
  const two = ed25519Data(v2); two[0] = 2;
  assert.equal(signedMessageOf(two), null);
  assert.equal(signedMessageOf(Buffer.alloc(8)), null);
  // an offset that points past the end
  const lie = ed25519Data(v2); lie.writeUInt16LE(60000, 10);
  assert.equal(signedMessageOf(lie), null);
  assert.deepEqual(signedMessageOf(ed25519Data(v3)), v3);
});

test('the other refusals still hold: failed tx, other program, mainnet, unknown cluster', async () => {
  const r = rec({ deviceHash: crypto.randomBytes(32) });
  await assert.rejects(verifyPostedTx(chain(ed25519Data(r), { genesis: GENESIS.mainnet }), { signature: SIG, programId: PROGRAM }), /mainnet is not supported/);
  await assert.rejects(verifyPostedTx(chain(ed25519Data(r), { genesis: 'x' }), { signature: SIG, programId: PROGRAM }), /neither devnet/);
  await assert.rejects(verifyPostedTx(chain(ed25519Data(r)), { signature: SIG, programId: 'OtherProgram' }), /does not call the Notch program/);
  await assert.rejects(verifyPostedTx(chain(ed25519Data(r)), { signature: 'short', programId: PROGRAM }), /not a transaction signature/);
});

// ---- REAL devnet transactions (captured from app/scripts/e2e-devnet.mjs steps 12 and 13, program 4ucSsrca...) ----------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/devnet-posted');
const real = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const realRpc = ({ signature, tx }) => async (method, params) => (method === 'getGenesisHash' ? GENESIS.devnet : params[0] === signature ? tx : null);

for (const [name, version, len] of [['v2-direct', 2, 128], ['v2-inbox', 2, 128], ['v3-direct', 3, 160], ['v3-inbox', 3, 160]]) {
  test(`REAL devnet post_limit transaction (${name}): v${version}, whole ${len} byte signed record hashed`, async () => {
    const f = real(name);
    const v = await verifyPostedTx(realRpc(f), { signature: f.signature, programId: PROGRAM });
    assert.equal(v.version, version);
    assert.equal(v.cluster, 'devnet');
    // recompute independently from the raw instruction: the digest is over exactly the signed bytes, and the signature verifies
    const keys = f.tx.transaction.message.accountKeys;
    const ix = f.tx.transaction.message.instructions.find((i) => keys[i.programIdIndex] === ED25519_PROGRAM);
    const data = Buffer.from(bs58.decode(ix.data));
    const msg = data.subarray(112, 112 + len);
    assert.equal(data.length, 112 + len);
    assert.equal(v.recordSha256, recordSha256(msg.toString('base64')));
    assert.equal(nacl.sign.detached.verify(msg, data.subarray(48, 112), data.subarray(16, 48)), true, 'the underwriter\'s real signature');
    assert.equal(v.wallet, bs58.encode(msg.subarray(8, 40)));
    if (version === 3) assert.notEqual(v.recordSha256, crypto.createHash('sha256').update(msg.subarray(0, 128)).digest('hex'));
  });
}
