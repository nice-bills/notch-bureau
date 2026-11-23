import { ENCLAVE_URL } from './config';
import { useState } from 'react';
import nacl from 'tweetnacl';
import { simulate, accountExists } from './chain';
import { useChain } from './data';
import { useWallet } from './wallet';
import { underwrite, recordBytes, getAttestation, type EnclaveResult } from './enclave';
import { explainError, TxError } from './errors';
import { address, getAddressEncoder } from '@solana/kit';
import { decodeRecord, deriveDedupe, deriveIdentity, hasIdentity, deriveLine, encodeRecord, postLimitIxs, USDC, bytesToBase64, bytesToHex } from './notch';
import { Btn, Notice } from './ui';
import { formatUsdc } from './amount';

interface Step {
  label: string;
  /** true = the attack was stopped, false = it got through, null = informational */
  blocked: boolean | null;
  friendly: string;
  raw: string;
}

// A valid-looking address for the sealed computer when no wallet is connected. Attacks (a) and (b) never touch the chain without a wallet.
const DEMO_WALLET = '11111111111111111111111111111112';

async function loadSampleEmail(): Promise<{ name: string; bytes: Uint8Array }> {
  const r = await fetch(`${ENCLAVE_URL}/samples/momo.eml`);
  const t = await r.text();
  if (!r.ok || !/DKIM-Signature/i.test(t)) throw new Error('No email to attack yet. Choose one on the Borrow screen, or run "pnpm demo:enclave" to create sample emails.');
  return { name: 'momo.eml', bytes: new TextEncoder().encode(t) };
}

/**
 * Edit one thing in the email body and leave every other byte alone. MoMo amounts live inside the base64 PDF
 * attachment, so the edit flips one byte there (the decoded PDF changes, the body hash no longer matches).
 * Emails with amounts in plain text (no base64 attachment) still get their first money amount changed.
 */
export function tamperAmount(eml: Uint8Array): { bytes: Uint8Array; before: string; after: string } {
  const s = new TextDecoder('latin1').decode(eml);
  const split = s.search(/\r?\n\r?\n/);
  const head = s.slice(0, split);
  const body = s.slice(split);
  const toBytes = (edited: string) => {
    const out = new Uint8Array(edited.length);
    for (let i = 0; i < edited.length; i++) out[i] = edited.charCodeAt(i) & 0xff;
    return out;
  };
  // The first base64 attachment: the lines after its blank line, up to the next boundary.
  const part = body.match(/Content-Transfer-Encoding:\s*base64[^\n]*\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/i);
  if (part && part.index !== undefined) {
    const start = part.index + part[0].length - part[1].length;
    const lines = part[1].split(/\r?\n/).filter((l) => l.length >= 8);
    if (lines.length > 2) {
      // Change one base64 character in the middle of the file (a middle line, never the padding).
      const line = lines[Math.floor(lines.length / 2)];
      const at = start + part[1].indexOf(line) + Math.floor(line.length / 2);
      const was = body[at];
      const now = was === 'A' ? 'B' : 'A';
      const edited = head + body.slice(0, at) + now + body.slice(at + 1);
      return { bytes: toBytes(edited), before: `${was} in the attached PDF`, after: now };
    }
  }
  const m = body.match(/\d[\d,]*\.\d{2}/);
  if (!m || m.index === undefined) throw new Error('Could not find an amount in this email to edit.');
  const after = `9${m[0]}`;
  const edited = head + body.slice(0, m.index) + after + body.slice(m.index + m[0].length);
  return { bytes: toBytes(edited), before: m[0], after };
}

const enclaveRaw = (r: EnclaveResult) => JSON.stringify(r.ok ? { ok: true, limitUsdc: r.limitUsdc } : { ok: false, reason: r.reason }, null, 2);

export function Attacks() {
  const { connected } = useWallet();
  const { addrs, session } = useChain();
  const owner = connected?.address ?? null;
  const [out, setOut] = useState<Record<string, Step[] | { error: string } | 'running'>>({});
  const set = (k: string, v: Step[] | { error: string } | 'running') => setOut((o) => ({ ...o, [k]: v }));

  const baseEmail = async () => session.eml ?? loadSampleEmail();

  const attackEdited = async () => {
    set('a', 'running');
    try {
      const email = await baseEmail();
      const { bytes, before, after } = tamperAmount(email.bytes);
      const res = await underwrite(bytes, owner ?? DEMO_WALLET);
      set('a', [
        { label: `Changed ${before} to ${after} inside the email, nothing else`, blocked: null, friendly: `The edited copy was sent to the sealed computer as ${email.name}.`, raw: '' },
        { label: 'Sealed computer’s answer', blocked: !res.ok, friendly: res.ok ? 'It accepted a forged email. That should not happen.' : res.friendly, raw: enclaveRaw(res) },
      ]);
    } catch (e) {
      set('a', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const attackTwice = async () => {
    set('b', 'running');
    try {
      const email = await baseEmail();
      const who = owner ?? DEMO_WALLET;
      const steps: Step[] = [];
      const first = await underwrite(email.bytes, who);
      let r1 = null as Awaited<ReturnType<typeof underwrite>> & { ok: true } | null;
      if (first.ok) {
        r1 = first;
        if (owner) session.setSigned(first);
        steps.push({ label: 'First time', blocked: null, friendly: `Accepted: limit ${formatUsdc(decodeRecord(recordBytes(first)).limitMicro, { max: 2 })} USDC.`, raw: enclaveRaw(first) });
      } else {
        steps.push({ label: 'First time', blocked: null, friendly: `Already counted earlier: ${first.friendly}`, raw: enclaveRaw(first) });
        if (session.signed) r1 = session.signed as typeof r1;
      }
      const second = await underwrite(email.bytes, who);
      steps.push({ label: 'Same email, second time: sealed computer', blocked: !second.ok, friendly: second.ok ? 'It counted the same email twice. That should not happen.' : second.friendly, raw: enclaveRaw(second) });

      // Even a copy of the first signed record cannot be posted twice on Solana.
      if (owner && addrs && r1) {
        const rec = recordBytes(r1);
        const decoded = decodeRecord(rec);
        const dedupe = await deriveDedupe(addrs.program, decoded.dedupe);
        const identity = hasIdentity(decoded.idHash) ? await deriveIdentity(addrs.program, decoded.idHash) : undefined;
        if (await accountExists(dedupe)) {
          const line = await deriveLine(addrs.program, owner);
          const uw = await getUnderwriterKey();
          const sim = await simulate(owner, postLimitIxs(addrs, { payer: owner, borrower: owner, line, dedupe, record: rec, identity }, uw, base64Bytes(r1.signature)));
          const e = explainError(new TxError(sim.err ?? 'ok', sim.logs));
          steps.push({ label: 'Same email, posted to Solana again: program', blocked: !sim.ok, friendly: sim.ok ? 'The program accepted it twice. That should not happen.' : e.message, raw: sim.logs.join('\n') || (sim.err ?? '') });
        } else {
          steps.push({ label: 'On Solana', blocked: null, friendly: 'This limit has not been posted yet. Post it from the Borrow screen, then run this again to watch the program refuse a second copy too.', raw: '' });
        }
      }
      set('b', steps);
    } catch (e) {
      set('b', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const attackForged = async () => {
    set('c', 'running');
    try {
      if (!owner || !addrs) throw new Error('Connect a wallet first. The test runs as a dry run, so nothing is sent and nothing is spent.');
      const rogue = nacl.sign.keyPair();
      const dedupeHash = crypto.getRandomValues(new Uint8Array(32));
      const record = encodeRecord({ wallet: owner, limitMicro: 2000n * USDC, expiry: Math.floor(Date.now() / 1000) + 30 * 86400, dedupe: dedupeHash, nonce: BigInt(Date.now()) });
      const signature = nacl.sign.detached(record, rogue.secretKey);
      const dedupe = await deriveDedupe(addrs.program, dedupeHash);
      const line = await deriveLine(addrs.program, owner);
      const sim = await simulate(owner, postLimitIxs(addrs, { payer: owner, borrower: owner, line, dedupe, record }, rogue.publicKey, signature));
      const e = explainError(new TxError(sim.err ?? 'ok', sim.logs));
      set('c', [
        { label: 'We made our own key and signed a 2,000 USDC limit for your wallet', blocked: null, friendly: `Signer: ${bytesToHex(rogue.publicKey).slice(0, 16)}… (not the Notch underwriter). Signature checks out cryptographically.`, raw: bytesToBase64(signature) },
        { label: 'The program’s answer (dry run)', blocked: !sim.ok, friendly: sim.ok ? 'The program accepted a limit signed by a stranger. That should not happen.' : e.message, raw: sim.logs.join('\n') || (sim.err ?? '') },
      ]);
    } catch (e) {
      set('c', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="attacks">
      <div className="lede">
        <h2>Try to cheat it</h2>
        <p>Three ways to fake a credit limit. Each one runs for real against the sealed computer or the Solana program, and shows the answer unedited.</p>
      </div>

      <AttackCard n="A" title="Edit the email" what="Make the payment look 10x bigger inside a real, signed email." run={attackEdited} state={out.a} cta="Edit and send" />
      <AttackCard n="B" title="Use the same email twice" what="Count one payment as income two times to stack limits." run={attackTwice} state={out.b} cta="Send it twice" />
      <AttackCard n="C" title="Sign a limit ourselves" what="Skip the sealed computer: sign a 2,000 USDC limit with our own key and hand it to the program." run={attackForged} state={out.c} cta="Forge and submit (dry run)" needsWallet={!owner} />
    </div>
  );
}

function AttackCard({ n, title, what, run, state, cta, needsWallet }: { n: string; title: string; what: string; run: () => Promise<void>; state: Step[] | { error: string } | 'running' | undefined; cta: string; needsWallet?: boolean }) {
  const running = state === 'running';
  return (
    <section className="attack">
      <header>
        <span className="attack-n" aria-hidden="true">{n}</span>
        <div>
          <h3>{title}</h3>
          <p>{what}</p>
        </div>
        <Btn variant="secondary" onClick={() => void run()} busy={running} disabled={needsWallet}>{cta}</Btn>
      </header>
      {needsWallet && <p className="step-help">Connect a wallet to run this one. It is a dry run: nothing is sent.</p>}
      {state && state !== 'running' && ('error' in state ? <Notice tone="warn">{state.error}</Notice> : (
        <ol className="attack-steps">
          {state.map((s, i) => (
            <li key={i} className={s.blocked === true ? 'blocked' : s.blocked === false ? 'leaked' : 'info'}>
              <div className="attack-line">
                {s.blocked !== null && <span className="verdict">{s.blocked ? 'Blocked' : 'Got through'}</span>}
                <strong>{s.label}</strong>
              </div>
              <p>{s.friendly}</p>
              {s.raw && <details className="real-error" open={s.blocked === true}><summary>Real error</summary><pre>{s.raw}</pre></details>}
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function getUnderwriterKey(): Promise<Uint8Array> {
  const a = await getAttestation();
  return new Uint8Array(getAddressEncoder().encode(address(a.underwriter)));
}
