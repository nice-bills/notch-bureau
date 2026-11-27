import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import { getBase58Decoder } from '@solana/kit';
// @ts-expect-error plain .mjs service, no types
import { makeFaucetServer, parseSecretKey } from '../scripts/faucet-server.mjs';
import { isDemoSealed, sealedLabel } from '../src/enclave';

describe('faucet service', () => {
  const calls: string[] = [];
  const server = makeFaucetServer({
    address: 'FaucetAddr',
    getFaucet: async () => ({ drip: async (w: string) => { calls.push(w); return { status: 200, body: { ok: true } }; } }),
  });
  let url = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('reads the key as base58 or as a JSON array, and never quotes a bad one', () => {
    const k = nacl.sign.keyPair().secretKey;
    expect(parseSecretKey(getBase58Decoder().decode(k))).toEqual(k);
    expect(parseSecretKey(JSON.stringify(Array.from(k)))).toEqual(k);
    expect(() => parseSecretKey('not-a-key-0OIl')).toThrow('FAUCET_KEY is not a base58 string or a JSON array');
    expect(() => parseSecretKey('[1,2,3]')).toThrow('64 byte');
  });

  it('answers health, CORS preflight and the drip route', async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true, faucet: 'FaucetAddr' });
    const pre = await fetch(`${url}/demo/faucet`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST');
    const r = await fetch(`${url}/demo/faucet`, { method: 'POST', body: JSON.stringify({ wallet: 'abc' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(calls).toEqual(['abc']);
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });
});

describe('sealed computer attestation shapes', () => {
  const local = { underwriter: 'x', mode: 'local-dev' };
  const cvm = { underwriter: 'x', mode: { demo_fixtures: true } };
  it('treats the local server and the confidential VM demo build as demo', () => {
    expect(isDemoSealed(local)).toBe(true);
    expect(isDemoSealed(cvm)).toBe(true);
    expect(isDemoSealed({ underwriter: 'x', mode: { demo_fixtures: false } })).toBe(false);
  });
  it('always labels it with a string (an object here crashed the account sheet)', () => {
    expect(sealedLabel(cvm)).toBe('Secure hardware (Intel TDX), demo build');
    expect(sealedLabel(local)).toBe('Local prototype, not yet in secure hardware');
  });
});
