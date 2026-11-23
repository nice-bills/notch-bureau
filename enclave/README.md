# Notch enclave (underwriter)

Reads a DKIM-signed income email, returns a signed 128-byte credit record. Raw email, amounts, sender and
phone number never leave the process. Run: `pnpm start`. Test: `pnpm test` (no network).

## How an email becomes a limit

1. **DKIM** (`src/dkim.js`): a passing signature from a trusted domain; the signature must cover `From` (and
   `Content-Type` when present); `d=` must align with the From domain; `l=` signatures are refused. The DKIM
   body hash covers every byte after the headers, **PDF attachments included**, so a signed statement cannot
   have its PDF edited or a second PDF appended (tested).
2. **Reader by source kind** (`src/sources.js`):
   - `email-body`: amounts in the email text (rules + optional AI reader, see below).
   - `statement-pdf` (MTN MoMo): `src/mime.js` pulls the PDF parts, `src/pdf-text.js` reads positioned text
     (pdf.js), `src/statement.js` parses the table. A password-protected PDF is refused with a clear reason.
   - `earn-payout` (Superteam Earn): email names a USDC amount **and** `src/chain-payout.js` finds a USDC credit
     of that amount (±0.5%) to the borrower's own token account within ±7 days of the email date (injectable
     RPC). A transfer in which the wallet also sent USDC (self-transfer) does not count; one transfer cannot
     back two emails.
3. **Identity** (statements only): the account phone number is normalised (E.164 digits), hashed as
   `sha256("notch-msisdn"|number)` and written into the record as `id_hash`. One number may back **one** wallet:
   the enclave refuses a second wallet (in memory, and via the chain: `getIdentityOwner`), and the program
   refuses it too (`IdentityLink` PDA `["identity", id_hash]` created in `post_limit`, error `IdentityBound`).
   Sources with no bindable identity (Earn, Wise, ...) carry an all-zero `id_hash` and skip the link.
4. **Limit** (`src/underwrite.js`), then Ed25519-sign the record (`src/record.js`, `NOTCHv2`).

### Statement parsing (security model)
- Columns come from the table's own header row; a transaction row is a line whose **first column holds a date**,
  so a memo that wraps onto a new line (it stays in the From/To column) can never pass for a row.
- The amount is read **only from the Amount column**; Fee and Balance are ignored; free-text columns are ignored.
- A row is income only if its Type is on the credit list (`CASH_IN`, `TRANSFER_IN`, `SALARY`, ...). Debits,
  fees, airtime and unknown types are ignored (fail closed).
- The phone number is read only from the header block above the table, from a line that **starts** with its label.
- Each row has a key (transaction id); overlapping statements never double count a row.
- AI reader (optional, `NOTCH_LLM_URL` + `NOTCH_LLM_MODEL`): every event it returns must be backed by one credit row
  (same currency and amount, each row used once, amount literally in the PDF text). The row supplies the date and
  kind. If nothing is corroborated the rules result is used.

### Privacy caveat on `id_hash`
There are only about 10^9 phone numbers, so a plain `sha256("notch-msisdn"|number)` on chain can be reversed by
trying every number. Set `NOTCH_ID_PEPPER` (a long random secret, never change it afterwards) and the hash becomes
`sha256("notch-msisdn"|pepper|number)`. Without it the key is exactly the plain form.

### Not solved yet
- **Statement ownership**: a statement can be mailed to any address, and anyone holding someone else's statement
  could present it first and claim that number for their wallet. Needs a phone proof (SMS OTP to the number) before
  the binding, which the DKIM mail alone cannot give.
- Self-paid Earn payouts: anyone can create a sponsor and pay themselves. Earn proof needs a sponsor allowlist.

## Config (env)

| var | meaning |
| --- | --- |
| `NOTCH_SUPERTEAM_DOMAIN` | DKIM domain of Earn payout emails (default `superteam.fun`) |
| `NOTCH_ID_PEPPER` | secret mixed into the identity hash (see above) |
| `SOLANA_RPC_URL`, `NOTCH_PROGRAM_ID` | chain reads (credit history, identity links, Earn payout proof) |
| `NOTCH_USDC_MINT` | mint the Earn proof looks for (default mainnet USDC) |
| `NOTCH_LLM_URL`, `NOTCH_LLM_MODEL`, `NOTCH_LLM_KEY` | AI reader (must be a confidential endpoint, see `src/llm-extract.js`) |

## SOURCES

Status: **modelled** = a real message was seen second-hand and the format is modelled here; **unverified until a
real sample** = the domain comes from DNS evidence only (DMARC and DKIM selectors, see `RESEARCH-CORE.md`), the email
format has never been seen, and nothing below should be trusted for real money until a raw `.eml` is checked.

| Source | Trusted `d=` | Reader | Evidence | Status |
| --- | --- | --- | --- | --- |
| MTN MoMo Ghana | `mtn.com` (**not** `mtn.com.gh`: no MX, no DMARC) | statement PDF, phone-number identity | monthly statement on request from `ServiceMMStatement.GH@mtn.com`, PDF `MomoStatementReport.pdf` (secondary sample, Scribd). DMARC `p=reject`. SPF includes Oracle email delivery, so the signer could be Oracle with `d=mtn.com` | modelled; **PDF column names/types are guessed** |
| Superteam Earn | `superteam.fun` (configurable) | email amount + on-chain USDC proof | Earn queues payment emails through Resend; `resend._domainkey.superteam.fun` exists; DMARC only `p=none`; template wording unknown | unverified until a real sample |
| Wise | `wise.com` | email body | DMARC `p=reject`; selectors `google`, `s1`, `s2`, `mandrill`, `k1` | unverified until a real sample |
| Payoneer | `payoneer.com` | email body | DMARC `p=reject`; selectors `selector1/2`, `mandrill` | unverified until a real sample |
| Deel | `deel.com` | email body | DMARC `p=reject`; selectors `s1`, `s2`, `google`, `mail` | unverified until a real sample |
| Upwork | `upwork.com` | email body | DMARC `p=reject`; selectors not probed | unverified until a real sample |

Removed: `mtn.com.gh`. Not yet listed (no evidence of signed income email): Telecel Cash, AirtelTigo Money, M-Pesa
(statement is password-protected, password arrives by SMS: refused today), Ghana banks.

## Needs a real sample before real use
1. One raw MoMo statement `.eml` (headers: `d=`, selector, whether `h=` covers `content-type`, From local part) and
   its PDF: real column headers, transaction type names, how debits are shown, date format, where the phone number
   sits, whether the PDF is password-protected. The parser keeps all of that in `src/statement.js` (`COLUMN_WORDS`,
   `CREDIT_TYPES`, `LABELLED_NUMBER`).
2. One Superteam Earn payout email (sender domain, wording, whether it quotes a transaction signature).
3. One email each from Wise, Payoneer, Deel, Upwork (`d=`, wording, amount and currency format).
