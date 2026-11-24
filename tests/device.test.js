// One phone = one borrower, on chain: DeviceLink PDA ["device", device_hash], the same pattern as IdentityLink.
// A v3 record (NOTCHv3, 160 bytes) carries device_hash = sha256("notch-sgt"|mint) at bytes 128..160; a v2 record has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { generateKeyPairSigner } from '@solana/kit';
import { enc, exists, fails, pda, postLimit, readLine, record, setup } from './lib.js';

const device = (mint = bs58.encode(crypto.randomBytes(32))) => crypto.createHash('sha256').update(`notch-sgt|${mint}`).digest();
const linkOwner = (ctx, addr) => {
  const a = ctx.svm.getAccount(addr);
  return a.exists ? bs58.encode(Buffer.from(a.data).subarray(8, 40)) : null;
};

test('device: a v3 record creates the DeviceLink for the wallet; the same wallet can re-post; v2 records still work', async () => {
  const ctx = await setup();
  const deviceHash = device();
  const msg = record(ctx, { deviceHash, nonce: 1 });
  assert.equal(msg.length, 160);
  assert.equal(msg.subarray(0, 8).toString('latin1'), 'NOTCHv3\0');
  assert.ok((await postLimit(ctx, msg)).ok);
  const link = await pda(Buffer.from('device'), deviceHash);
  assert.equal(linkOwner(ctx, link), ctx.borrower.address);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * 1_000_000n);
  // same wallet, newer statement and a higher Seeker limit: fine
  assert.ok((await postLimit(ctx, record(ctx, { deviceHash, nonce: 2, limitUsdc: 75 }))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 75n * 1_000_000n);
  // a plain v2 record (no device) afterwards: still accepted, nothing is bound to it
  const v2 = record(ctx, { nonce: 3, limitUsdc: 40 });
  assert.equal(v2.length, 128);
  assert.ok((await postLimit(ctx, v2)).ok);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 40n * 1_000_000n);
});

test('device ATTACK: a second wallet presenting the same phone is refused with DeviceBound and leaves nothing behind', async () => {
  const ctx = await setup();
  const deviceHash = device();
  assert.ok((await postLimit(ctx, record(ctx, { deviceHash, nonce: 1 }))).ok);
  const thief = await generateKeyPairSigner();
  const r = await postLimit(ctx, record(ctx, { deviceHash, wallet: thief.address, nonce: 1 }), { borrower: thief.address });
  fails(r, 'DeviceBound');
  assert.equal(readLine(ctx.svm, await pda(Buffer.from('line'), enc.encode(thief.address))), null, 'refused post leaves no line');
  assert.equal(linkOwner(ctx, await pda(Buffer.from('device'), deviceHash)), ctx.borrower.address, 'the link did not move');
});

test('device ATTACK: the device account is required for a v3 record, and it must be the right one', async () => {
  const ctx = await setup();
  const deviceHash = device();
  fails(await postLimit(ctx, record(ctx, { deviceHash }), { device: false }), 'DeviceRequired');
  const wrong = await pda(Buffer.from('device'), crypto.randomBytes(32));
  fails(await postLimit(ctx, record(ctx, { deviceHash }), { device: wrong }), 'ConstraintSeeds');
  // a device account passed with a record that has no device is refused too (its seed is empty)
  fails(await postLimit(ctx, record(ctx, { nonce: 5 }), { device: await pda(Buffer.from('device'), deviceHash) }), 'ConstraintSeeds');
  assert.equal(readLine(ctx.svm, ctx.line), null);
  assert.equal(await exists(ctx, await pda(Buffer.from('device'), deviceHash)), false);
});

test('device ATTACK: the device hash is covered by the signature (swap it after signing)', async () => {
  const ctx = await setup();
  const signed = record(ctx, { deviceHash: device() });
  const sent = Buffer.from(signed);
  device().copy(sent, 128);
  fails(await postLimit(ctx, sent, { signedMsg: signed }), 'RecordMismatch');
  // and a v2 record cannot be stretched into a v3 one by appending a device
  const v2 = record(ctx, { nonce: 9 });
  const stretched = Buffer.concat([v2, device()]);
  stretched.write('NOTCHv3\0', 0, 'latin1');
  fails(await postLimit(ctx, stretched, { signedMsg: v2 }), 'RecordMismatch');
});

test('device: record length and tag must agree (v2 tag with 160 bytes, v3 tag with 128 bytes: BadRecord)', async () => {
  const ctx = await setup();
  const v3 = record(ctx, { deviceHash: device() });
  const asV2 = Buffer.from(v3);
  asV2.write('NOTCHv2\0', 0, 'latin1');
  fails(await postLimit(ctx, asV2), 'BadRecord');
  const v2 = record(ctx, { nonce: 4 });
  const shortV3 = Buffer.from(v2);
  shortV3.write('NOTCHv3\0', 0, 'latin1');
  fails(await postLimit(ctx, shortV3), 'BadRecord');
  assert.equal(readLine(ctx.svm, ctx.line), null);
});

test('device + identity together: both links are claimed; either one already used by another wallet refuses the whole post', async () => {
  const ctx = await setup();
  const idHash = crypto.createHash('sha256').update('notch-msisdn|233241234567').digest();
  const deviceHash = device();
  assert.ok((await postLimit(ctx, record(ctx, { idHash, deviceHash, nonce: 1 }))).ok);
  assert.equal(linkOwner(ctx, await pda(Buffer.from('identity'), idHash)), ctx.borrower.address);
  assert.equal(linkOwner(ctx, await pda(Buffer.from('device'), deviceHash)), ctx.borrower.address);
  const thief = await generateKeyPairSigner();
  const opts = { borrower: thief.address };
  // same phone number, a different phone
  const newPhone = device();
  fails(await postLimit(ctx, record(ctx, { idHash, deviceHash: newPhone, wallet: thief.address, nonce: 1 }), opts), 'IdentityBound');
  assert.equal(await exists(ctx, await pda(Buffer.from('device'), newPhone)), false, 'a refused post claims no phone');
  // same phone, a different phone number
  const newId = crypto.randomBytes(32);
  fails(await postLimit(ctx, record(ctx, { idHash: newId, deviceHash, wallet: thief.address, nonce: 1 }), opts), 'DeviceBound');
  assert.equal(await exists(ctx, await pda(Buffer.from('identity'), newId)), false, 'a refused post claims no phone number');
  // a Seeker with no mobile-money identity (e.g. a Superteam Earn email): identity placeholder + device
  const other = device();
  const w2 = await generateKeyPairSigner();
  assert.ok((await postLimit(ctx, record(ctx, { deviceHash: other, wallet: w2.address, nonce: 1 }), { borrower: w2.address })).ok);
  assert.equal(linkOwner(ctx, await pda(Buffer.from('device'), other)), w2.address);
});
