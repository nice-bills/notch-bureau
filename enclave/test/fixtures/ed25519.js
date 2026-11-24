// The data of an Ed25519 verify instruction, in the layout the Solana runtime (and app/src/notch.ts ed25519VerifyIx) uses:
// 16 byte header (1 signature, offsets, "same instruction" markers), public key, signature, then the message.
export function ed25519Data(message, { publicKey = Buffer.alloc(32, 7), signature = Buffer.alloc(64, 9), msgIx = 0xffff } = {}) {
  const header = Buffer.alloc(16);
  header[0] = 1;
  header.writeUInt16LE(48, 2); header.writeUInt16LE(0xffff, 4); header.writeUInt16LE(16, 6); header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(112, 10); header.writeUInt16LE(message.length, 12); header.writeUInt16LE(msgIx, 14);
  return Buffer.concat([header, publicKey, signature, message]);
}
