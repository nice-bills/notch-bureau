import { useMemo } from 'react';
import { bytesToHex, decodeRecord, base64ToBytes } from './notch';
import { formatDate, formatUsdc, shortAddr } from './amount';
import type { EnclaveOk } from './enclave';

/** The one thing that leaves the sealed computer: a signed 96 byte record. Nothing else. */
export function Ticket({ result, wallet }: { result: EnclaveOk; wallet: string }) {
  const rec = useMemo(() => decodeRecord(base64ToBytes(result.message)), [result.message]);
  const sig = useMemo(() => bytesToHex(base64ToBytes(result.signature)), [result.signature]);
  return (
    <figure className="ticket" aria-label="What left the sealed computer">
      <div className="ticket-top">
        <figcaption className="ticket-title">What left the sealed computer</figcaption>
        <p className="ticket-limit">
          <span className="ticket-num">{formatUsdc(rec.limitMicro, { max: 2 })}</span>
          <span className="ticket-unit">USDC credit limit</span>
        </p>
        <dl className="ticket-facts">
          <div><dt>Made for wallet</dt><dd className="mono" translate="no">{shortAddr(wallet, 5)}</dd></div>
          <div><dt>Good until</dt><dd>{formatDate(rec.expiry)}</dd></div>
          <div><dt>Email fingerprint</dt><dd className="mono" translate="no" title="A one-way hash. It stops the same email counting twice and reveals nothing about what the email says.">{bytesToHex(rec.dedupe).slice(0, 12)}…</dd></div>
          <div><dt>Counter</dt><dd className="mono" translate="no">{rec.nonce.toString().slice(-8)}</dd></div>
        </dl>
        <p className="ticket-sig"><span>Signature</span><span className="mono" translate="no">{sig.slice(0, 28)}…{sig.slice(-8)}</span></p>
      </div>
      <div className="ticket-perf" aria-hidden="true" />
      <div className="ticket-bottom">
        <p className="ticket-title muted">Stayed inside</p>
        <ul className="ticket-kept">
          <li>The email text and who sent it to you</li>
          <li>Every payment amount and date</li>
          <li>Names, phone numbers, employer</li>
          <li>Your income, in any currency</li>
        </ul>
      </div>
    </figure>
  );
}
