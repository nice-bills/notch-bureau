#!/usr/bin/env node
// DEVNET ONLY: the test-money faucet as its own small web service (Render), for the hosted demo whose sealed computer has none.
//
//   FAUCET_KEY=<base58 or JSON array secret key> MINT=<test USDC mint> node scripts/faucet-server.mjs
//
// Env: FAUCET_KEY (secret, a dedicated faucet wallet, never the admin), MINT, RPC_URL (default devnet), PORT (default 8788),
//      HOST (default 0.0.0.0).
// POST /demo/faucet {"wallet": "<address>"} transfers 0.02 SOL + 100 test USDC out of the faucet wallet (limits: faucet.mjs).
// GET /health answers 200 while the process is up. Refuses mainnet. The key is never logged.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getAddressDecoder, getBase58Encoder } from '@solana/kit';
import { createFaucet } from './faucet.mjs';

const DEFAULT_RPC = 'https://api.devnet.solana.com';

/** FAUCET_KEY: a base58 string or a JSON array, 64 bytes either way. Errors never quote the value. */
export function parseSecretKey(text) {
  const s = String(text || '').trim();
  let bytes;
  try {
    bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : Uint8Array.from(getBase58Encoder().encode(s));
  } catch {
    throw new Error('FAUCET_KEY is not a base58 string or a JSON array');
  }
  if (bytes.length !== 64) throw new Error('FAUCET_KEY must be a 64 byte secret key');
  return bytes;
}

export function makeFaucetServer({ getFaucet, address }) {
  return http.createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' };
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/health') return send(200, { ok: true, faucet: address });
      if (req.method !== 'POST' || pathname !== '/demo/faucet') return send(404, { ok: false, reason: 'not found' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 1024) return send(413, { ok: false, reason: 'too large' }); }
      let wallet = '';
      try { wallet = JSON.parse(body).wallet; } catch { /* reported by drip */ }
      const faucet = await getFaucet();
      if (!faucet) return send(503, { ok: false, reason: 'The test faucet cannot reach Solana devnet right now. Try again in a minute.' });
      const r = await faucet.drip(wallet);
      return send(r.status, r.body);
    } catch (e) {
      console.error('faucet request failed:', e instanceof Error ? e.message : e);
      return send(500, { ok: false, reason: 'The test faucet hit a problem. Try again in a minute.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
  const mint = process.env.MINT;
  if (/mainnet/i.test(rpcUrl)) { console.error('refusing to run against a mainnet RPC URL. Devnet only.'); process.exit(1); }
  if (!mint) { console.error('MINT is required (the test USDC mint address)'); process.exit(1); }
  let secretKey;
  try { secretKey = parseSecretKey(process.env.FAUCET_KEY); } catch (e) { console.error(e.message); process.exit(1); }
  delete process.env.FAUCET_KEY;
  const address = getAddressDecoder().decode(secretKey.subarray(32));
  // Built on first use and kept: a devnet hiccup at boot must not leave the faucet off until the next restart.
  let ready = null;
  const getFaucet = async () => {
    ready ??= createFaucet({ secretKey, rpcUrl, mint, mintNew: false }).catch(() => null);
    const f = await ready;
    if (!f) ready = null;
    return f;
  };
  const port = Number(process.env.PORT || 8788);
  makeFaucetServer({ getFaucet, address }).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`devnet faucet ${address} on :${port} (mint ${mint})`));
}
