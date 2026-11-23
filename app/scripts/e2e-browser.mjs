#!/usr/bin/env node
// Browser e2e on a LOCAL solana-test-validator (no public RPC, so no 429 rate limits).
//
//   pnpm e2e                      # starts the validator, runs the Playwright suite against it, stops it
//   pnpm e2e -- -g "4\."          # extra args go to Playwright
//   pnpm e2e:browser:devnet       # same suite against real devnet instead (needs app/.env.local + devnet SOL)
//
// What it does:
//   1  starts solana-test-validator on 127.0.0.1 with target/deploy/notch.so preloaded at the program's real ID
//   2  airdrops SOL to a throwaway admin key (app/e2e/.state/local-admin.json, never your real key)
//   3  runs scripts/devnet-setup.mjs against it (localnet guard): test USDC mint + init with the demo
//      underwriter's key (../.underwriter-key.json) + a seeded lender pool
//   4  runs Playwright with VITE_RPC_URL / VITE_USDC_MINT pointing at the local validator, 1 worker
//   5  stops the validator and deletes its ledger
// Local only: mainnet is never touched.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { getAddressDecoder } from '@solana/kit';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const root = path.resolve(app, '..');
const soFile = path.join(root, 'target/deploy/notch.so');
const keyFile = path.join(root, '.underwriter-key.json');
const stateDir = path.join(app, 'e2e/.state');
const adminFile = path.join(stateDir, 'local-admin.json');
const PROGRAM_ID = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
const RPC_PORT = Number(process.env.E2E_LOCAL_RPC_PORT || 8899);
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const bin = path.join(os.homedir(), '.local/share/solana/install/active_release/bin');
const validatorBin = fs.existsSync(path.join(bin, 'solana-test-validator')) ? path.join(bin, 'solana-test-validator') : 'solana-test-validator';

const die = (m) => { console.error(`[e2e-browser] ${m}`); process.exit(1); };
const log = (m) => console.log(`[e2e-browser] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(soFile)) die(`${soFile} is missing. Build it first (cargo build-sbf).`);
if (!fs.existsSync(keyFile)) die(`${keyFile} is missing (the demo underwriter key). Start the demo enclave once with NOTCH_KEY_FILE set.`);

const portBusy = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
if (await portBusy(RPC_PORT)) die(`port ${RPC_PORT} is already in use (another validator?). Stop it or set E2E_LOCAL_RPC_PORT.`);
for (const [port, what] of [[5173, 'a Vite dev server'], [8787, 'the demo underwriter']]) {
  // A leftover Vite would keep pointing at devnet; a leftover enclave is fine only if it already runs the shared key.
  if (port === 5173 && (await portBusy(port))) die(`port ${port} is busy (${what} already running, probably aimed at devnet). Stop it so the harness can start one for the local chain.`);
}

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-e2e-ledger-'));
log(`starting solana-test-validator (ledger ${ledger})`);
const validator = spawn(validatorBin, [
  '--reset', '--quiet',
  '--ledger', ledger,
  '--bind-address', '127.0.0.1',
  '--rpc-port', String(RPC_PORT),
  '--faucet-port', String(RPC_PORT + 1001),
  '--limit-ledger-size', '50000000',
  '--bpf-program', PROGRAM_ID, soFile,
], { stdio: ['ignore', 'ignore', 'inherit'] });

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { validator.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { fs.rmSync(ledger, { recursive: true, force: true }); } catch { /* best effort */ } }, 1500);
};
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });
validator.on('exit', (code) => { if (!stopped) { console.error(`[e2e-browser] validator exited early (${code})`); process.exit(1); } });

try {
  // 1. wait for the validator
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { await rpc('getHealth'); up = true; } catch { await sleep(500); }
  }
  if (!up) die('validator did not come up in 60 s');
  const genesis = await rpc('getGenesisHash');
  if (genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') die('this is mainnet. Refusing.');
  const prog = await rpc('getAccountInfo', [PROGRAM_ID, { encoding: 'base64' }]);
  if (!prog.value?.executable) die(`program ${PROGRAM_ID} is not loaded on the local validator`);
  log(`validator up, program ${PROGRAM_ID} loaded`);

  // 2. throwaway admin + airdrop
  fs.mkdirSync(stateDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  fs.writeFileSync(adminFile, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  const adminAddr = getAddressDecoder().decode(kp.publicKey);
  for (let i = 0; i < 4; i++) {
    const sig = await rpc('requestAirdrop', [adminAddr, 500_000_000_000]); // 500 SOL, local play money
    for (let j = 0; j < 60; j++) {
      const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
      await sleep(500);
    }
  }
  log(`admin ${adminAddr} funded`);

  // 3. mint + init + seeded pool (reuses devnet-setup.mjs, which has a localnet guard)
  const underwriter = getAddressDecoder().decode(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))).subarray(32, 64));
  const setup = spawnSync(process.execPath, [
    path.join(here, 'devnet-setup.mjs'), '--send', '--rpc', RPC, '--program', PROGRAM_ID, '--keypair', adminFile,
    '--underwriter', underwriter, '--expiry-days', '365', '--seed-pool', '1000',
  ], { cwd: app, encoding: 'utf8' });
  process.stdout.write(setup.stdout || '');
  process.stderr.write(setup.stderr || '');
  if (setup.status !== 0) die('devnet-setup.mjs failed against the local validator');
  const mint = (setup.stdout.match(/^test USDC\s+(\S+)/m) || [])[1];
  if (!mint) die('could not read the test USDC mint from the setup output');

  // 4. Playwright, 1 worker, against the local chain
  const extra = process.argv.slice(2).filter((a) => a !== '--');
  const env = {
    ...process.env,
    VITE_RPC_URL: RPC,
    VITE_PROGRAM_ID: PROGRAM_ID,
    VITE_USDC_MINT: mint,
    E2E_ADMIN_KEYPAIR: adminFile,
  };
  log(`running Playwright against ${RPC} (mint ${mint})`);
  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts', '--workers=1', ...extra], { cwd: app, env, stdio: 'inherit' });
  const code = await new Promise((res) => pw.on('exit', (c) => res(c ?? 1)));
  stop();
  fs.rmSync(adminFile, { force: true });
  process.exit(code);
} catch (e) {
  stop();
  die(e instanceof Error ? e.message : String(e));
}
