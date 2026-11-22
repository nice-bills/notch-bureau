import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifyEmail } from './dkim.js';
import { extractIncomeAuto, llmConfigFromEnv } from './llm-extract.js';
import { computeLimit } from './underwrite.js';
import { signRecord } from './record.js';

export const DEFAULT_TRUSTED = ['deel.com', 'mtn.com.gh', 'mtn.com', 'wise.com', 'payoneer.com', 'superteam.fun'];
const RECORD_TTL_S = 30 * 86400;

// The "sealed computer". Today it runs as a normal process; in TDX the same code runs
// inside the enclave and the key never leaves it. Raw emails are never stored or returned.
export class Underwriter {
  constructor({
    secretKey,
    trusted = DEFAULT_TRUSTED,
    resolver,
    historyProvider,
    now = () => new Date(),
    llm = llmConfigFromEnv(),
    llmFetch,
  } = {}) {
    this.keys = secretKey ? nacl.sign.keyPair.fromSecretKey(secretKey) : nacl.sign.keyPair();
    this.trusted = trusted;
    this.resolver = resolver;
    this.historyProvider = historyProvider;
    this.now = now;
    this.llm = llm; // null => rules-only extraction, no outbound calls
    this.llmFetch = llmFetch;
    this.wallets = new Map(); // wallet -> { events, repaidOnTime, frozen }
    this.used = new Set(); // dedupe hashes (hex)
    this.nonce = 0n;
  }

  get publicKey() {
    return bs58.encode(this.keys.publicKey);
  }

  async submit(eml, wallet) {
    bs58.decode(wallet); // throws on a bad address
    const v = await verifyEmail(eml, { trusted: this.trusted, resolver: this.resolver });
    if (!v.ok) return { ok: false, reason: v.reason };
    const key = v.dedupe.toString('hex');
    if (this.used.has(key)) return { ok: false, reason: 'email already used' };

    const now = this.now();
    const extracted = await extractIncomeAuto(eml, { llm: this.llm, fetchImpl: this.llmFetch, now });
    const events = extracted.events;
    if (!events.length) return { ok: false, reason: 'no income found in email' };
    const prior = this.wallets.get(wallet) || { events: [] };
    const nextEvents = [
      ...prior.events,
      ...events.map((e) => ({ ...e, source: v.domain })),
    ];

    const history = this.historyProvider
      ? await this.historyProvider(wallet)
      : { repaidOnTime: 0, frozen: false };
    const { limitUsdc } = computeLimit(nextEvents, { now, ...history });
    this.used.add(key);
    this.wallets.set(wallet, { events: nextEvents });
    const expiry = Math.floor(now.getTime() / 1000) + RECORD_TTL_S;
    // Time-based so nonces keep rising across restarts (per-wallet ordering is checked onchain).
    const t = BigInt(now.getTime());
    this.nonce = t > this.nonce ? t : this.nonce + 1n;
    const signed = signRecord({ wallet, limitUsdc, expiry, dedupe: v.dedupe, nonce: this.nonce }, this.keys.secretKey);
    // Only the limit and its signed record leave the enclave: no income, no source domain.
    // `extraction` ('llm' | 'rules') says which reader ran and reveals nothing about the borrower.
    return {
      ok: true,
      extraction: extracted.via,
      limitUsdc,
      expiry,
      nonce: this.nonce.toString(),
      ...signed,
    };
  }
}
