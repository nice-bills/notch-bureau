# Getting a statement into Notch

Three ways in. A refusal never spends the inbox address; five lock it.

## 1. MTN MoMo emails the inbox directly (main path)
The user types their Notch address into MTN's statement request.

| What breaks | What the user sees |
| --- | --- |
| Address mistyped, or mail never sent | "Checking for your email…", then "Still nothing?" with a new-address button |
| Statement older than the address, or sent to another address | "Ask MTN for a new statement" / "sent to a different address" |
| Edited, or not signed by MTN | "signature does not check out" or "a sender we do not accept" |
| A PDF layout the reader does not know | "The sealed computer said no", with the reading problem |
| Sealed computer restarted, or 14 days passed | "This inbox address is no longer known": ask for a new one |

## 2. Forward as attachment (the sender only emails the user's own address)
Gmail on the web: open the original, More (⋮), Forward as attachment, send to the Notch address.
Accepted only if all hold: the forward is signed by Gmail, Outlook, Hotmail, Live, Yahoo or iCloud; it is addressed to
this wallet's inbox; it carries exactly one attached email (not itself a forward, at most 4 MB) signed by an accepted
income sender; that sender **signed** the To line, and it names the mailbox that forwarded it. The original counts once,
however it arrives.

| What breaks | What the user sees |
| --- | --- |
| Inline forward, or the original's signature broken | "Forward it as an attachment, not inline…" |
| Statement went to a different mailbox than the forwarder | "…sent to a different email than the one that forwarded it" |
| Work or school mail, or another provider | "Forward it from a Gmail, Outlook, … address" |
| Sender does not sign To (**MTN does not**: use path 1) | "…did not sign who this statement was sent to…" |
| Sender not on the accepted list | "…not signed by a sender that is accepted as proof of income" |
| Two attachments / a forward of a forward | "Attach exactly one original email" / "…is itself a forward" |

Left open: if a mail provider does not sign To on the forward, somebody who is sent a copy of that forward could claim
it, provided it is dated after they got their own address (same gap as MTN's direct path).

## 3. Upload a payout email (.eml)
Deel, Wise, Payoneer, Upwork, Superteam Earn. **Statements are always refused here**: anyone holding a copy could claim
the owner's phone number.

| What breaks | What the user sees |
| --- | --- |
| A mobile-money statement is uploaded | "…accepted only through your own Notch inbox address…" |
| An uploaded forward, or an unknown sender | "signature does not check out" or "sender we do not accept" |
| Same email twice | "already used this email" |
| No payment found, or no matching USDC transfer | the matching plain reason |

## Banks: refused today
- **No bank is accepted yet** (GCB included), so path 2 cannot count a bank statement today. Needed: a real raw `.eml`,
  the bank's signing domain in `enclave/src/sources.js`, and a reader for its PDF. Its signature must cover To.
- **No DKIM signature:** nothing proves the bank sent it. Needed: the bank signs its mail, or another proof from the bank
  (a digitally signed PDF checked against its certificate; not built).
- **PDF only (download or branch printout):** a bare PDF has no sender signature and is easy to edit. Same remedy.
- **Password-locked PDF:** refused; no way to give the password yet.
