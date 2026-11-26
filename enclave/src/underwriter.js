import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { toAddresses, verifyEmail } from './dkim.js';
import { extractIncomeAuto, extractStatementAuto, llmConfigFromEnv } from './llm-extract.js';
import { computeLimit } from './underwrite.js';
import { NO_IDENTITY, signRecord } from './record.js';
import { DeviceNonces, DeviceProofError, verifyDeviceProof } from './siws.js';
import { SgtUnavailable, createSgtReader, sgtHash } from './sgt.js';
import { DEFAULT_SUPERTEAM_DOMAIN, DEFAULT_TRUSTED as DEFAULT_TRUSTED_LIST, sourceTable } from './sources.js';
import { pdfAttachments } from './mime.js';
import { StatementError, identityHash, parseStatements } from './statement.js';
import { decodeEmailText } from './extract.js';
import { PEER_WEIGHT } from './income.js';
import crypto from 'node:crypto';
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
    sgtReader, // (wallet) => Promise<string[]> : the Seeker Genesis Token mints a wallet holds on MAINNET (default: public mainnet RPC, read only)
    deviceProvider, // (deviceHash: Buffer) => wallet | null : who the chain says owns this phone
    deviceNonces = new DeviceNonces(), // SIWS challenges this underwriter issued (single use, 5 minutes)
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
    this.walletIds = new Map(); // wallet -> id_hash hex (this process); the chain pin (WalletIdentityPinned) is the durable copy
    this.identities = new Map(); // identity hash (hex) -> wallet: one mobile-money account, one wallet
    this.rows = new Set(); // statement rows already counted (identity|row), so overlapping statements never double count
    this.payoutTxs = new Set(); // chain transfers already spent on an Earn email
    this.sgtReader = sgtReader;
    this.deviceProvider = deviceProvider;
    this.deviceNonces = deviceNonces;
    this.devices = new Map(); // device hash (hex) -> wallet: one Seeker phone, one credit line
    this.nonce = 0n;
  }

  // A fresh Sign-in-with-Solana payload for the borrower's wallet to sign (the first half of the device check).
  deviceChallenge() {
    return this.deviceNonces.issue();
  }

  // Checks a device proof NOW and spends its challenge (the statement inbox does this when the address is issued, because
  // the statement arrives days later). Throws DeviceProofError. It proves key ownership only; the Seeker token is read
  // when the statement arrives.
  verifyDevice(wallet, proof) {
    verifyDeviceProof(this.deviceNonces, wallet, proof);
  }

  get publicKey() {
    return bs58.encode(this.keys.publicKey);
  }

  // `recipient` (statement inbox): the address the mail was delivered to. The DKIM-signed To header must name it, so a
  // statement mailed to somebody else's inbox address cannot be redirected to this wallet.
  //
  // `device` (optional): { nonce, signature, signedMessage } = the wallet's Sign-in-with-Solana proof on a challenge from
  // deviceChallenge(). If it verifies AND the wallet holds a Seeker Genesis Token on mainnet, the record carries
  // sha256("notch-sgt"|mint) and the limit gets the Seeker uplift. A wallet with a valid proof but no SGT is simply not a
  // Seeker (limit as before). A bad proof is refused; an RPC outage is reported as retry-later, never as "not a Seeker".
  // `deviceProven` (statement inbox only, set by the Inbox from its own state): the proof was already verified when the
  // address was issued, so only the token read is left.
  // `dkim` ({ trusted, resolver? }) replaces this underwriter's DKIM settings for this one message. Only the in-process mail
  // bridge passes it (real mail is checked against real DNS even on a demo underwriter); no HTTP route does.
  async submit(eml, wallet, { recipient, device, deviceProven = false, dkim } = {}) {
    bs58.decode(wallet); // throws on a bad address
    const v = await verifyEmail(eml, dkim ?? { trusted: this.trusted, resolver: this.resolver });
    if (!v.ok) return { ok: false, reason: v.reason };
    if (recipient) {
      const to = toAddresses(eml);
      if (!v.signedHeaders.includes('to')) return { ok: false, reason: 'DKIM signature does not cover the To header, so the recipient cannot be trusted' };
      if (!to.ok || !to.addresses.includes(String(recipient).toLowerCase())) return { ok: false, reason: 'the statement was not addressed to this inbox' };
    }
    // Identity-bearing sources (a mobile-money statement binds a phone number to the wallet) are accepted ONLY through the
    // statement inbox, where the DKIM-signed To header was just checked against THIS wallet's own address. Without that, anyone
    // holding a copy of a victim's statement (a forwarded mail, a loan app that collected it) could post it first and bind the
    // victim's number to their own wallet for ever (audit #3). Non-identity sources keep the direct path.
    const kind = this.kinds.get(v.domain) || 'email-body';
    if (kind === 'statement-pdf' && !recipient) {
      return { ok: false, reason: 'a mobile-money statement is accepted only through your own Notch inbox address: ask MTN to mail it to the address you were given (it cannot be uploaded directly)' };
    }
    const key = v.dedupe.toString('hex');
    if (this.used.has(key)) return { ok: false, reason: 'email already used' };

    const now = this.now();
    let got;
    try {
      got = kind === 'statement-pdf' ? await this.#statement(eml, now)
        : kind === 'earn-payout' ? await this.#earn(eml, wallet, now, v.domain)
          : await this.#plain(eml, now, v.domain);
    } catch (e) {
      if (e instanceof Refusal || e instanceof StatementError) return { ok: false, reason: e.message };
      throw e;
    }

    // The wallet's own credit line (chain). Fails closed on RPC trouble.
    const history = this.historyProvider
      ? await this.historyProvider(wallet)
      : { repaidOnTime: 0, frozen: false };
    // Audit #5 (enclave side): no new limit while a loan is overdue; the program refuses draws then, and a fresh record would
    // only invite a pointless post. Pay (or let the keeper default) first.
    if ((history.drawn ?? 0n) > 0n && history.due > 0 && Math.floor(now.getTime() / 1000) > history.due && !history.frozen) {
      return { ok: false, reason: 'you have an overdue loan: repay it before asking for a new limit' };
    }
    // An Earn payout is spent by its ON-CHAIN transfer, not by the email that points at it: the record's dedupe (the program's
    // one-shot PDA) is a hash of the payout transaction signatures, so a second, different email about the same transfer maps to
    // the same dedupe and the program refuses it, even after this process restarted and forgot `payoutTxs` (audit #9).
    const dedupe = got.payoutTxs?.length
      ? crypto.createHash('sha256').update('notch-earn-v1').update([...got.payoutTxs].sort().join('|')).digest()
      : v.dedupe;
    if (got.payoutTxs?.length && this.used.has(dedupe.toString('hex'))) return { ok: false, reason: 'that payout was already used' };

    // One mobile-money account backs one wallet, ever. Checked here AND by the program (IdentityLink).
    const idHex = got.idHash ? got.idHash.toString('hex') : null;
    if (idHex) {
      const owner = this.identities.get(idHex) ?? (this.identityProvider ? await this.identityProvider(got.idHash) : null);
      if (owner && owner !== wallet) return { ok: false, reason: 'this mobile-money account is already linked to a different wallet' };
    }
    // Audit #10: one wallet, one mobile-money account. The program pins the first identity to the wallet (WalletIdentityPinned);
    // refuse here a statement for a different number so the user gets a clear answer instead of a failed transaction.
    const pinned = history.idHash ? history.idHash.toString('hex') : this.walletIds.get(wallet);
    if (idHex && pinned && pinned !== idHex) return { ok: false, reason: 'this wallet is already tied to a different mobile-money account' };

    if (!got.events.length) return { ok: false, reason: got.reason || 'no income found in email' };
    // Statements overlap (the 3-month statement you ask for tomorrow repeats today's rows): count each row once.
    let events = got.events;
    if (got.rowKeys) {
      events = events.filter((e) => !this.rows.has(`${idHex}|${e.txKey}`));
      if (!events.length) return { ok: false, reason: 'no new income in this statement: every credit in it was already counted' };
    }

    // One Seeker phone backs one credit line, ever. Checked here AND by the program (DeviceLink).
    let seeker = null;
    if (device || deviceProven) {
      try {
        seeker = await this.#device(wallet, device, deviceProven);
      } catch (e) {
        if (e instanceof DeviceProofError || e instanceof Refusal) return { ok: false, reason: e.message };
        if (e instanceof SgtUnavailable) return { ok: false, retry: true, reason: `${e.message}. This is not a "no Seeker" answer: try again in a moment` };
        throw e;
      }
    }

    const prior = this.wallets.get(wallet) || { events: [] };
    const nextEvents = [...prior.events, ...events.map((e) => ({ ...e, source: v.domain }))];
    const { limitUsdc } = computeLimit(nextEvents, { now, ...history, signals: got.signals, seeker: !!seeker });

    this.used.add(key);
    this.used.add(dedupe.toString('hex'));
    if (idHex) { this.identities.set(idHex, wallet); this.walletIds.set(wallet, idHex); }
    if (seeker) this.devices.set(seeker.hex, wallet);
    for (const e of events) if (got.rowKeys) this.rows.add(`${idHex}|${e.txKey}`);
    for (const sig of got.payoutTxs || []) this.payoutTxs.add(sig);
    this.wallets.set(wallet, { events: nextEvents });
    const expiry = Math.floor(now.getTime() / 1000) + RECORD_TTL_S;
    // Time-based so nonces keep rising across restarts (per-wallet ordering is checked onchain).
    const t = BigInt(now.getTime());
    this.nonce = t > this.nonce ? t : this.nonce + 1n;
    const signed = signRecord(
      { wallet, limitUsdc, expiry, dedupe, nonce: this.nonce, idHash: got.idHash || NO_IDENTITY, deviceHash: seeker?.hash },
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
      ...(device || deviceProven ? { seeker: !!seeker } : {}), // only said when a device proof was sent; the mint itself never leaves
      ...signed,
    };
  }

  // The two halves of the device check. -> { hash, hex } of the phone to bind, or null (valid proof, no Seeker token).
  async #device(wallet, proof, proven = false) {
    if (!proven) verifyDeviceProof(this.deviceNonces, wallet, proof); // half 1: the wallet signed our challenge just now
    const read = this.sgtReader || (this.sgtReader = createSgtReader()); // half 2: it holds an SGT (mainnet, read only)
    const mints = [...new Set(await read(wallet))].sort();
    if (!mints.length) return null;
    // A wallet may hold the tokens of several phones: bind the first one no OTHER wallet already uses.
    for (const mint of mints) {
      const hash = sgtHash(mint);
      const hex = hash.toString('hex');
      const owner = this.devices.get(hex) ?? (this.deviceProvider ? await this.deviceProvider(hash) : null);
      if (!owner || owner === wallet) return { hash, hex };
    }
    throw new Refusal('this Seeker phone is already linked to a different wallet');
  }

  // Amounts in the email text.
  async #plain(eml, now, domain) {
    const x = await extractIncomeAuto(eml, { llm: this.llm, fetchImpl: this.llmFetch, now, domain });
    // A person-to-person credit ("KOFI sent you ...") carries no proof of who the sender is, so it counts like a peer transfer
    // on a statement: PEER_WEIGHT of its value (audit #8). Payer-side templates (Deel, Wise payout ...) count in full.
    const events = x.events.map(({ peer, ...e }) => (peer ? { ...e, amount: e.amount * PEER_WEIGHT } : e));
    return { events, via: x.via };
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
  async #earn(eml, wallet, now, domain) {
    const x = await extractIncomeAuto(eml, { llm: this.llm, fetchImpl: this.llmFetch, now, domain });
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
