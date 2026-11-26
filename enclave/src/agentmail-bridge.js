// AgentMail bridge: a free shared mailbox instead of an own mail domain.
//
// Every wallet's address is <local>+<code>@<domain> of ONE AgentMail inbox (NOTCH_INBOX_ADDRESS, see inbox.js). This
// polls that inbox, downloads the RAW message (DKIM signature intact) and hands it to the inbox's receive path, exactly
// what the Cloudflare worker does through POST /inbound. Nothing about the transport is trusted: DKIM and the signed To
// header are checked by the underwriter as for any other delivery.
//
// PRIVACY: a real statement passes through here. The message is only held in memory; nothing about it is written to disk
// or logged: no address, code, subject, sender, message id, download link or reason sentence. Logs carry a status number
// and one of the fixed reason words from status.js.
import crypto from 'node:crypto';
import { MAX_INBOUND_BYTES, parseMailbox, recipientCode } from './inbox.js';
import { reasonCode } from './status.js';

const API_BASE = 'https://api.agentmail.to/v0';

// An underwriter that checks DKIM against the real world, whatever the wrapped one is set up with: a DEMO underwriter
// resolves every DKIM key to its test key, so real mail could never pass there. `dkim` is replaced in tests only.
export function realMailView(underwriter, dkim = { trusted: [...underwriter.kinds.keys()] }) {
  return { submit: (eml, wallet, opts) => underwriter.submit(eml, wallet, { ...opts, dkim }) };
}

// Two ways to deliver. Both resolve to { status, body } as POST /inbound answers.
export function deliverInProcess({ inbox, underwriter, dkim }) {
  const view = realMailView(underwriter, dkim);
  return (rcpt, eml) => inbox.receive(view, { rcpt, eml, secret: inbox.secret });
}

export function deliverOverHttp({ url, secret, fetchImpl = fetch, timeoutMs = 60_000 }) {
  return async (rcpt, eml) => {
    const r = await fetchImpl(`${String(url).replace(/\/+$/, '')}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-notch-rcpt': rcpt, 'x-notch-inbound-secret': secret },
      body: eml,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

// An error whose message was written here, so it is safe to log.
class BridgeError extends Error {}

export class AgentMailBridge {
  constructor({
    apiKey,
    address, // the shared mailbox, <local>@<domain> (also the AgentMail inbox id)
    deliver, // (rcpt, eml) => { status, body }
    knows = null, // (rcpt) => boolean : skip (do not even download) mail for codes this underwriter never issued
    fetchImpl = fetch,
    apiBase = API_BASE,
    pollMs = 10_000,
    lookbackMs = 5 * 60_000, // mail that arrived this long before the start is still considered
    maxAttempts = 20,
    maxPages = 10,
    timeoutMs = 30_000,
    now = () => Date.now(),
    log = (m) => console.log(m),
  } = {}) {
    if (!apiKey) throw new Error('the AgentMail bridge needs AGENTMAIL_API_KEY');
    if (typeof deliver !== 'function') throw new Error('the AgentMail bridge needs a deliver function');
    this.mailbox = parseMailbox(address);
    this.inboxPath = `${apiBase}/inboxes/${encodeURIComponent(`${this.mailbox.local}@${this.mailbox.domain}`)}`;
    this.apiKey = apiKey;
    this.deliver = deliver;
    this.knows = knows;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.since = now() - lookbackMs;
    this.maxAttempts = maxAttempts;
    this.maxPages = maxPages;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.log = log;
    this.done = new Set(); // message ids handled for good (memory only: open codes do not survive a restart either)
    this.retrying = new Map(); // message id -> { attempts, nextAt }
    this.running = null;
    this.timer = null;
    this.stopped = true;
    this.lastPollAt = 0;
    this.poked = null;
  }

  // The first To address that is a plus address of the shared mailbox (and, when we can tell, one we issued).
  rcptOf(message) {
    for (const to of [message?.to].flat()) {
      for (const [address] of String(to || '').toLowerCase().matchAll(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g)) {
        if (recipientCode(address, { domain: this.mailbox.domain, mailbox: this.mailbox }) && (!this.knows || this.knows(address))) return address;
      }
    }
    return null;
  }

  // One pass over the new mail. Calls while one is running share it. -> [{ status, reason }] of this pass's deliveries.
  pollOnce() {
    this.running ??= this.#pass().finally(() => { this.running = null; });
    return this.running;
  }

  async #pass() {
    this.lastPollAt = this.now();
    const results = [];
    const fresh = [];
    let pageToken = null;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams({ limit: '50', include_spam: 'true', include_unauthenticated: 'true' }); // DKIM decides, not the spam filter
      if (pageToken) q.set('page_token', pageToken);
      const list = await this.#api(`/messages?${q}`, 'list');
      const messages = Array.isArray(list.messages) ? list.messages : [];
      const recent = messages.filter((m) => !(Date.parse(m.created_at || m.timestamp) < this.since));
      const unhandled = recent.filter((m) => typeof m.message_id === 'string' && !this.done.has(m.message_id));
      fresh.push(...unhandled);
      pageToken = list.next_page_token;
      // newest first: stop at the start-up horizon, or at a page we already know (unless a retry may be further down)
      if (!pageToken || !recent.length || (!unhandled.length && !this.retrying.size)) break;
    }
    for (const m of fresh.reverse()) { // oldest first
      const r = await this.#handle(m);
      if (r) results.push(r);
    }
    return results;
  }

  async #handle(message) {
    const id = message.message_id;
    const wait = this.retrying.get(id);
    if (wait && wait.nextAt > this.now()) return null;
    // Our own outgoing mail is listed too.
    const rcpt = message.labels?.includes('sent') && !message.labels.includes('received') ? null : this.rcptOf(message);
    if (!rcpt) { this.#finish(id); return null; }
    try {
      const eml = await this.#raw(id);
      if (!eml) { this.#finish(id); this.log('agentmail: a message was too large and was skipped'); return null; }
      const r = await this.deliver(rcpt, eml);
      const reason = r.status === 200 ? null : reasonCode(r.body?.reason);
      this.log(`agentmail: message handled: ${r.status}${reason ? ` ${reason}` : ''}`);
      if (r.status === 409 || r.status >= 500) this.#again(id); // busy, an outage, or a crash: the address is still good
      else this.#finish(id);
      return { status: r.status, reason: r.body?.reason ?? null };
    } catch (e) {
      // Foreign error messages can quote a URL or the mail itself: log only our own words, or the error's class.
      this.log(`agentmail: could not handle a message (${e instanceof BridgeError ? e.message : e?.name || 'Error'}), will retry`);
      this.#again(id);
      return null;
    }
  }

  #finish(id) {
    this.retrying.delete(id);
    this.done.add(id);
    if (this.done.size > 20_000) this.done.delete(this.done.values().next().value);
  }

  #again(id) {
    const attempts = (this.retrying.get(id)?.attempts || 0) + 1;
    if (attempts >= this.maxAttempts) { this.#finish(id); this.log('agentmail: gave up on a message'); return; }
    this.retrying.set(id, { attempts, nextAt: this.now() + Math.min(this.pollMs * 2 ** (attempts - 1), 10 * 60_000) });
  }

  async #api(path, what) {
    const r = await this.fetch(`${this.inboxPath}${path}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new BridgeError(`${what}: HTTP ${r.status}`);
    return r.json();
  }

  // The raw message, or null when it is bigger than /inbound would take. The signed download link gets NO API key.
  async #raw(id) {
    const info = await this.#api(`/messages/${encodeURIComponent(id)}/raw`, 'raw');
    if (Number(info.size) > MAX_INBOUND_BYTES) return null;
    if (!/^https:\/\//i.test(info.download_url || '')) throw new BridgeError('raw: no https download link');
    const r = await this.fetch(info.download_url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new BridgeError(`download: HTTP ${r.status}`);
    const chunks = [];
    let size = 0;
    for await (const c of r.body ?? []) {
      size += c.length;
      if (size > MAX_INBOUND_BYTES) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    const tick = async () => {
      try { await this.pollOnce(); } catch (e) {
        this.log(`agentmail: poll failed (${e instanceof BridgeError ? e.message : e?.name || 'Error'})`);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, 0);
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.poked);
    this.poked = null;
  }

  // "New mail" hint (the webhook): poll soon. Many hints make one poll, at most one every `minGapMs`.
  poke(minGapMs = 2000) {
    if (this.poked) return;
    this.poked = setTimeout(async () => {
      await this.running?.catch(() => {}); // a pass already under way may have listed before the new mail arrived
      this.poked = null;
      await this.pollOnce().catch(() => this.log('agentmail: poll failed'));
    }, Math.max(0, this.lastPollAt + minGapMs - this.now()));
  }
}

// AgentMail's message.received webhook: POST /agentmail/webhook. The body is thrown away unread, so there is nothing to
// forge: all it does is make the bridge poll sooner. Returns true when it answered the request.
export function handleAgentMailWebhook(bridge, req, url, send) {
  if (!bridge || req.method !== 'POST' || url.pathname !== '/agentmail/webhook') return false;
  req.resume();
  bridge.poke();
  send(202, { ok: true });
  return true;
}

// Is the bridge switched on by the environment?
export const agentMailConfigured = (env = process.env) => Boolean(env.AGENTMAIL_API_KEY && env.NOTCH_INBOX_ADDRESS);

// The runner used inside an underwriter process. `inbox` must be the plus-address inbox of NOTCH_INBOX_ADDRESS.
// Returns a started bridge, or null when the environment does not ask for one.
export function startAgentMailBridge({ env = process.env, inbox, underwriter, dkim, log, ...opts }) {
  if (!agentMailConfigured(env)) return null;
  const { local, domain } = parseMailbox(env.NOTCH_INBOX_ADDRESS);
  if (inbox.mailbox?.local !== local || inbox.domain !== domain) throw new Error('the AgentMail bridge and the inbox must use the same NOTCH_INBOX_ADDRESS');
  inbox.secret ||= crypto.randomBytes(24).toString('hex'); // in-process delivery only; nobody outside learns it
  return new AgentMailBridge({
    apiKey: env.AGENTMAIL_API_KEY,
    address: env.NOTCH_INBOX_ADDRESS,
    deliver: deliverInProcess({ inbox, underwriter, dkim }),
    knows: (rcpt) => inbox.knows(rcpt),
    pollMs: Number(env.NOTCH_AGENTMAIL_POLL_MS) || 10_000,
    ...(log ? { log } : {}),
    ...opts,
  }).start();
}
