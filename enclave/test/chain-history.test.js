import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { getCreditHistory } from '../src/chain-history.js';

const programId = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
const wallet = bs58.encode(crypto.randomBytes(32));
const accountDisc = crypto.createHash('sha256').update('account:CreditLine').digest().subarray(0, 8);

function rpcResponse(value) {
  return {
    ok: true,
    async json() {
      return { result: { value } };
    },
  };
}

test('missing credit line returns first-time history', async () => {
  const history = await getCreditHistory(wallet, {
    programId,
    fetchImpl: async () => rpcResponse(null),
  });
  assert.deepEqual(history, { repaidOnTime: 0, frozen: false });
});

test('reads repayment count and default flag from the credit line', async () => {
  const data = Buffer.alloc(90);
  accountDisc.copy(data, 0);
  Buffer.from(bs58.decode(wallet)).copy(data, 8);
  data.writeUInt32LE(3, 72);
  data[88] = 1;
  const history = await getCreditHistory(wallet, {
    programId,
    fetchImpl: async () => rpcResponse({
      owner: programId,
      data: [data.toString('base64'), 'base64'],
    }),
  });
  assert.deepEqual(history, { repaidOnTime: 3, frozen: true });
});

test('rejects a credit line owned by a different program', async () => {
  await assert.rejects(
    getCreditHistory(wallet, {
      programId,
      fetchImpl: async () => rpcResponse({ owner: '11111111111111111111111111111111', data: ['', 'base64'] }),
    }),
    /unexpected program/,
  );
});
