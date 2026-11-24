// An Underwriter that submits every email as if it had been DELIVERED TO the fixtures' inbox address (their To header,
// student@example.com). A mobile-money statement is only accepted with a `recipient` (audit #3: statements come in
// through the inbox, where the DKIM-signed To header is checked against the wallet's own address); the tests that are
// about income, identity, devices and the AI reader do not care about the delivery, so they use this. Tests of the
// delivery rule itself (underwriter.test.js, inbox*.test.js, audit-underwrite.test.js) use the real Underwriter.
import { Underwriter } from '../../src/underwriter.js';

export const FIXTURE_INBOX = 'student@example.com';

export class InboxedUnderwriter extends Underwriter {
  submit(eml, wallet, opts = {}) {
    return super.submit(eml, wallet, { recipient: FIXTURE_INBOX, ...opts });
  }
}
