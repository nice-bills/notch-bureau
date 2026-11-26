// Inbox refusals read as what they are, never as a broken signature.
import { describe, expect, it } from 'vitest';
import { explainEnclaveReason } from '../src/errors';

const cases: [string, RegExp][] = [
  ['the statement was sent before you asked for this address; request a new statement', /sent before you asked for this address/],
  ['the statement is dated in the future, so it cannot be accepted', /dated in the future/],
  ['the email provider did not sign a readable date and message ID, so this statement cannot be tied to your request', /sent for your request/],
  ['the statement was not addressed to this inbox', /different address/],
  ['message has several To headers', /repeated header lines/],
  ['message has several Message-ID headers', /repeated header lines/],
  ['email already used', /already used this email/],
];

describe('explainEnclaveReason: inbox refusals', () => {
  it.each(cases)('%s', (reason, want) => {
    const said = explainEnclaveReason(reason);
    expect(said).toMatch(want);
    expect(said).not.toMatch(/signature does not check out/);
  });
  it('a really bad signature still says so', () => {
    expect(explainEnclaveReason('no passing DKIM signature (mtn.com:fail)')).toMatch(/signature does not check out/);
  });
});
