import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { toAddresses, verifyEmail } from './dkim.js';
import { extractIncomeAuto, extractStatementAuto, llmConfigFromEnv } from './llm-extract.js';
import { computeLimit } from './underwrite.js';
import { NO_IDENTITY, signRecord } from './record.js';
import { DEFAULT_SUPERTEAM_DOMAIN, DEFAULT_TRUSTED as DEFAULT_TRUSTED_LIST, sourceTable } from './sources.js';
import { pdfAttachments } from './mime.js';
import { StatementError, identityHash, parseStatements } from './statement.js';
import { decodeEmailText } from './extract.js';
import { USDC_MINT_MAINNET, findUsdcReceipt, makeRpc, signatureIn } from './chain-payout.js';

export const DEFAULT_TRUSTED = DEFAULT_TRUSTED_LIST;
const RECORD_TTL_S = 30 * 86400;

// A reason that is safe to show the borrower (it never contains the email, an amount, or a phone number).
class Refusal extends Error {}

// The "sealed computer". Today it runs as a normal process; in TDX the same code runs
// inside the enclave and the key never leaves it. Raw emails are never stored or returned.
export class Underwriter {
  constructor({
    secretKey,
    trusted,
    resolver,
    historyProvider,
    now = () => new Date(),
    llm = llmConfigFromEnv(),
    llmFetch,
    superteamDomain = process.env.NOTCH_SUPERTEAM_DOMAIN || DEFAULT_SUPERTEAM_DOMAIN,
    idPepper = process.env.NOTCH_ID_PEPPER || '',
    identityProvider, // (idHash: Buffer) => wallet | null : who the chain says owns this identity
    chainRpc, // (method, params) => result : Solana JSON-RPC used for Earn payout proofs
    usdcMint = process.env.NOTCH_USDC_MINT || USDC_MINT_MAINNET,
  } = {}) {
    this.keys = secretKey ? nacl.sign.keyPair.fromSecretKey(secretKey) : nacl.sign.keyPair();
    const sources = sourceTable({ superteamDomain });
    this.kinds = new Map(sources.map((s) => [s.domain, s.kind]));
    this.trusted = trusted ?? sources.map((s) => s.domain);
    this.resolver = resolver;
    this.historyProvider = historyProvider;
    this.now = now;
    this.llm = llm; // null => rules-only extraction, no outbound calls
    this.llmFetch = llmFetch;
    this.idPepper = idPepper;
    this.identityProvider = identityProvider;
    this.chainRpc = chainRpc;
    this.usdcMint = usdcMint;
    this.wallets = new Map(); // wallet -> { events }
    this.used = new Set(); // dedupe hashes (hex)
    this.identities = new Map(); // identity hash (hex) -> wallet: one mobile-money account, one wallet
    this.rows = new Set(); // statement rows already counted (identity|row), so overlapping statements never double count
    this.payoutTxs = new Set(); // chain transfers already spent on an Earn email
    this.nonce = 0n;
  }

  get publicKey() {
    return bs58.encode(this.keys.publicKey);
  }

  // `recipient` (statement inbox): the address the mail was delivered to. The DKIM-signed To header must name it, so a
  // statement mailed to somebody else's inbox address cannot be redirected to this wallet.
  async submit(eml, wallet, { recipient } = {}) {
    bs58.decode(wallet); // throws on a bad address
    const v = await verifyEmail(eml, { trusted: this.trusted, resolver: this.resolver });
    if (!v.ok) return { ok: false, reason: v.reason };
    if (recipient) {
      const to = toAddresses(eml);
      if (!v.signedHeaders.includes('to')) return { ok: false, reason: 'DKIM signature does not cover the To header, so the recipient cannot be trusted' };
      if (!to.ok || !to.addresses.includes(String(recipient).toLowerCase())) return { ok: false, reason: 'the statement was not addressed to this inbox' };
    }
    const key = v.dedupe.toString('hex');
    if (this.used.has(key)) return { ok: false, reason: 'email already used' };

    const now = this.now();
    let got;
    try {
      const kind = this.kinds.get(v.domain) || 'email-body';
      got = kind === 'statement-pdf' ? await this.#statement(eml, now)
        : kind === 'earn-payout' ? await this.#earn(eml, wallet, now)
          : await this.#plain(eml, now);
    } catch (e) {
      if (e instanceof Refusal || e instanceof StatementError) return { ok: false, reason: e.message };
      throw e;
    }

    // One mobile-money account backs one wallet, ever. Checked here AND by the program (IdentityLink).
    const idHex = got.idHash ? got.idHash.toString('hex') : null;
    if (idHex) {
      const owner = this.identities.get(idHex) ?? (this.identityProvider ? await this.identityProvider(got.idHash) : null);
      if (owner && owner !== wallet) return { ok: false, reason: 'this mobile-money account is already linked to a different wallet' };
    }
    if (!got.events.length) return { ok: false, reason: got.reason || 'no income found in email' };
    // Statements overlap (the 3-month statement you ask for tomorrow repeats today's rows): count each row once.
    let events = got.events;
    if (got.rowKeys) {
      events = events.filter((e) => !this.rows.has(`${idHex}|${e.txKey}`));
      if (!events.length) return { ok: false, reason: 'no new income in this statement: every credit in it was already counted' };
    }

    const prior = this.wallets.get(wallet) || { events: [] };
    const nextEvents = [...prior.events, ...events.map((e) => ({ ...e, source: v.domain }))];
    const history = this.historyProvider
      ? await this.historyProvider(wallet)
      : { repaidOnTime: 0, frozen: false };
    const { limitUsdc } = computeLimit(nextEvents, { now, ...history, signals: got.signals });

    this.used.add(key);
    if (idHex) this.identities.set(idHex, wallet);
    for (const e of events) if (got.rowKeys) this.rows.add(`${idHex}|${e.txKey}`);
    for (const sig of got.payoutTxs || []) this.payoutTxs.add(sig);
    this.wallets.set(wallet, { events: nextEvents });
    const expiry = Math.floor(now.getTime() / 1000) + RECORD_TTL_S;
    // Time-based so nonces keep rising across restarts (per-wallet ordering is checked onchain).
    const t = BigInt(now.getTime());
    this.nonce = t > this.nonce ? t : this.nonce + 1n;
    const signed = signRecord(
      { wallet, limitUsdc, expiry, dedupe: v.dedupe, nonce: this.nonce, idHash: got.idHash || NO_IDENTITY },
      this.keys.secretKey,
    );
    // Only the limit and its signed record leave the enclave: no income, no source domain, no phone number
    // (the record carries a hash of it). `extraction` ('llm' | 'rules') says which reader ran and reveals
    // nothing about the borrower.
    return {
      ok: true,
      extraction: got.via,
      limitUsdc,
      expiry,
      nonce: this.nonce.toString(),
      ...signed,
    };
  }

  // Amounts in the email text.
  async #plain(eml, now) {
    const x = await extractIncomeAuto(eml, { llm: this.llm, fetchImpl: this.llmFetch, now });
    return { events: x.events, via: x.via };
  }

  // Amounts in a PDF statement; the account's phone number is the identity.
  async #statement(eml, now) {
    let pdfs;
    try {
      pdfs = await pdfAttachments(eml);
    } catch (e) {
      throw new Refusal(`could not read the email attachments (${e.message})`);
    }
    const statement = await parseStatements(pdfs, { now });
    const x = await extractStatementAuto(statement, { llm: this.llm, fetchImpl: this.llmFetch, now });
    const base = { via: x.via, idHash: identityHash(statement.msisdn, this.idPepper), rowKeys: true, signals: x.signals };
    if (!x.events.length) {
      return { ...base, events: [], reason: 'no earned income found: money from yourself, loans, betting, savings, one-off transfers, money that passed straight through, and cash deposits that were not regular or that left again within a week are not counted' };
    }
    return { ...base, events: x.events };
  }

  // Earn payout email + the matching USDC credit on chain.
  async #earn(eml, wallet, now) {
    const x = await extractIncomeAuto(eml, { llm: this.llm, fetchImpl: this.llmFetch, now });
    const usdc = x.events.filter((e) => e.currency === 'USDC' || e.currency === 'USD');
    if (!usdc.length) throw new Refusal('no USDC payout found in the Earn email');
    const rpc = this.chainRpc || (this.chainRpc = makeRpc());
    const hint = signatureIn(decodeEmailText(eml));
    const spent = new Set(this.payoutTxs);
    const proven = [];
    for (const e of usdc) {
      const hit = await findUsdcReceipt({ wallet, amountUsdc: e.amount, at: e.date, mint: this.usdcMint, rpc, exclude: spent, hint });
      if (!hit) continue;
      spent.add(hit.signature);
      proven.push({ event: { ...e, currency: 'USDC' }, signature: hit.signature });
    }
    if (!proven.length) throw new Refusal('no matching USDC transfer to your wallet within 7 days of this email');
    return { events: proven.map((p) => p.event), via: x.via, payoutTxs: proven.map((p) => p.signature) };
  }
}
