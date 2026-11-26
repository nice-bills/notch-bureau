// Turns what the underwriter does into the public status rows. It NEVER throws into the caller: a store that is down
// must not stop a statement from being checked (the signed record, not this row, is what the program trusts).
import { recordSha256 } from './store.js';

// A refusal sentence -> one of a short fixed list. The sentence itself is never stored.
export function reasonCode(text) {
  const t = String(text || '');
  if (/identity|already linked/i.test(t)) return 'identity_conflict';
  // The ways a mail fails to belong to this inbox request. Never 'dkim_failed': the signature itself was fine. The coarse
  // word stays inside the database's fixed list; the plain sentence reaches the borrower through GET /record.
  if (/not addressed to this inbox|To header|sent before you asked|dated in the future|tied to your request/i.test(t)) return 'wrong_inbox';
  if (/DKIM|untrusted signer|From domain|From header|To header/i.test(t)) return 'dkim_failed';
  if (/already used|already counted|no new income/i.test(t)) return 'already_counted';
  if (/no PDF statement|no transaction table/i.test(t)) return 'no_statement';
  if (/no (earned )?income|no USDC|no matching USDC/i.test(t)) return 'no_income';
  if (/could not|does not add up|unexpected|too many rows|different|mixes|more than one/i.test(t)) return 'unreadable';
  return 'other';
}

export class JobStatus {
  constructor(store, { log = (m) => console.error(m) } = {}) {
    this.store = store;
    this.log = log;
    this.tails = new Map();
  }

  // Steps for one code run strictly in order (the address row must exist before its first status step), even when a
  // caller does not wait for the previous one.
  #do(code, what, fn) {
    const prev = this.tails.get(code) || Promise.resolve();
    // Resolves true when the row was written, false when the store failed (logged, never thrown).
    const p = prev.then(fn).then(() => true, (e) => { this.log(`status store (${what}): ${String(e?.message || e).split('\n')[0]}`); return false; });
    this.tails.set(code, p);
    p.then(() => { if (this.tails.get(code) === p) this.tails.delete(code); });
    return p;
  }

  issued({ code, wallet, expiresAt }) { return this.#do(code, 'issued', () => this.store.inboxIssued({ code, wallet, expiresAt })); }
  dropped(code, state = 'expired') { return this.#do(code, 'dropped', () => this.store.inboxState({ code, state })); }
  received(code) { return this.#do(code, 'received', () => this.store.jobUpdate({ code, status: 'received' })); }
  checking(code) { return this.#do(code, 'checking', () => this.store.jobUpdate({ code, status: 'checking' })); }
  limitPosted(code, messageB64) { return this.#do(code, 'limit_posted', () => this.store.limitPosted({ code, recordSha256: recordSha256(messageB64) })); }
  refused(code, reason, { locked = false } = {}) {
    return this.#do(code, 'refused', async () => {
      await this.store.jobUpdate({ code, status: 'refused', reasonCode: reasonCode(reason) });
      if (locked) await this.store.inboxState({ code, state: 'locked' });
    });
  }
}
