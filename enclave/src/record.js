import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Signed credit record. Byte layout must match programs/notch/src/record.rs exactly.
// "NOTCHv2\0" | wallet[32] | limit_micro u64 LE | expiry i64 LE | dedupe[32] | nonce u64 LE | id_hash[32]  = 128 bytes
// id_hash = sha256("notch-msisdn"|number) for statement-backed records, all zeros when the source has no identity.
//
// "NOTCHv3\0" is the same 128 bytes plus device_hash[32] at 128..160 (= 160 bytes): the phone behind the wallet,
// sha256("notch-sgt"|mint) of its Seeker Genesis Token (src/sgt.js). It is used ONLY when a device is bound; a record without
// one is still a plain v2 record, byte for byte what it always was, so every old record, client and test keeps working.
export const TAG = Buffer.from('NOTCHv2\0', 'latin1');
export const TAG_V3 = Buffer.from('NOTCHv3\0', 'latin1');
export const RECORD_LEN = 128;
export const RECORD_LEN_V3 = 160;
export const NO_IDENTITY = Buffer.alloc(32);
export const NO_DEVICE = Buffer.alloc(32);

export function encodeRecord({ wallet, limitUsdc, expiry, dedupe, nonce, idHash = NO_IDENTITY, deviceHash = null }) {
  if (Buffer.from(idHash).length !== 32) throw new Error('id_hash must be 32 bytes');
  const withDevice = deviceHash && !Buffer.from(deviceHash).equals(NO_DEVICE);
  if (deviceHash && Buffer.from(deviceHash).length !== 32) throw new Error('device_hash must be 32 bytes');
  const buf = Buffer.alloc(withDevice ? RECORD_LEN_V3 : RECORD_LEN);
  (withDevice ? TAG_V3 : TAG).copy(buf, 0);
  if (withDevice) Buffer.from(deviceHash).copy(buf, 128);
  Buffer.from(bs58.decode(wallet)).copy(buf, 8);
  buf.writeBigUInt64LE(BigInt(Math.round(limitUsdc * 1e6)), 40);
  buf.writeBigInt64LE(BigInt(expiry), 48);
  Buffer.from(dedupe).copy(buf, 56);
  buf.writeBigUInt64LE(BigInt(nonce), 88);
  Buffer.from(idHash).copy(buf, 96);
  return buf;
}

export function signRecord(fields, secretKey) {
  const msg = encodeRecord(fields);
  const sig = nacl.sign.detached(msg, secretKey);
  return { message: msg.toString('base64'), signature: Buffer.from(sig).toString('base64') };
}

export function verifyRecord(messageB64, signatureB64, publicKey) {
  return nacl.sign.detached.verify(Buffer.from(messageB64, 'base64'), Buffer.from(signatureB64, 'base64'), publicKey);
}
