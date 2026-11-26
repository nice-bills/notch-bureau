# Notch enclave (underwriter)

Reads a DKIM-signed income email, returns a signed 128-byte credit record (160 bytes when a Seeker phone is bound). Raw email, amounts, sender and
phone number never leave the process. Run: `pnpm start`. Test: `pnpm test` (no network).

## How an email becomes a limit

1. **DKIM** (`src/dkim.js`): a passing signature from a trusted domain; the signature must cover `From` (and
   `Content-Type` when present); `d=` must align with the From domain; `l=` signatures are refused. The DKIM
   body hash covers every byte after the headers, **PDF attachments included**, so a signed statement cannot
   have its PDF edited or a second PDF appended (tested).
2. **Reader by source kind** (`src/sources.js`):
   - `email-body`: amounts in the email text (rules + optional AI reader, see below).
   - `statement-pdf` (MTN MoMo): `src/mime.js` pulls the PDF parts, `src/pdf-text.js` reads positioned text
     (pdf.js), `src/statement.js` parses the table, `src/income.js` sorts the credits (below). A password-protected PDF is refused with a clear reason.
   - `earn-payout` (Superteam Earn): email names a USDC amount **and** `src/chain-payout.js` finds a USDC credit
     of that amount (±0.5%) to the borrower's own token account within ±7 days of the email date (injectable
     RPC). A transfer in which the wallet also sent USDC (self-transfer) does not count; one transfer cannot
     back two emails.
3. **Identity** (statements only): the account phone number is normalised (E.164 digits), hashed as
   `sha256("notch-msisdn"|pepper|number)` with a **secret pepper** (see "Privacy caveat on `id_hash`") and written into the record as
   `id_hash`. One number may back **one** wallet, for everyone, Seeker or not:
   the enclave refuses a second wallet (in memory, and via the chain: `getIdentityOwner`), and the program
   refuses it too (`IdentityLink` PDA `["identity", id_hash]` created in `post_limit`, error `IdentityBound`).
   Sources with no bindable identity (Earn, Wise, ...) carry an all-zero `id_hash` and skip the link.
4. **Device** (optional, see "One phone = one borrower" below): a Sign-in-with-Solana proof + a Seeker Genesis Token adds
   `device_hash` to the record (`NOTCHv3`, 160 bytes) and the Seeker uplift to the limit.
5. **Limit** (`src/underwrite.js`), then Ed25519-sign the record (`src/record.js`, `NOTCHv2`, or `NOTCHv3` with a device).

### One Seeker phone = one credit line (Seeker Genesis Token): `src/siws.js`, `src/sgt.js`, `src/device-http.js`
**Optional.** The rule "one phone backs one line" applies to **Seeker-bound lines only** (lines whose record carries a `device_hash`).
Non-Seekers work exactly as before and are not bound to any phone. The MoMo-number rule (one number = one wallet) applies to **everyone**.

A MoMo number already backs one wallet; a fraudster with five SIM cards could still open five lines. A Seeker phone carries a
**Seeker Genesis Token** (SGT, a Token-2022 NFT minted once per phone, on **mainnet**). Verification has two halves and both are required
(doing only the second lets anyone submit a Seeker owner's public address):
1. **Sign-in-with-Solana** proves the user holds the wallet key now. `POST /device/nonce` returns the whole payload (domain, uri,
   statement, `chainId: solana:mainnet`, nonce, 5 minute expiry); the wallet signs it (plus its own address). The nonce is single use,
   consumed before anything else is checked. The verifying key comes from the wallet being underwritten, never from the request.
2. **The wallet holds an SGT**: `@solana-mobile/skr-genesis-token` reads the wallet's Token-2022 accounts on a mainnet RPC (read only, no
   transaction is ever sent; `NOTCH_SGT_RPC_URL`, default the public RPC). An RPC failure is `503 retry`, never "not a Seeker".
`POST /underwrite` takes the proof in header `x-notch-device` = base64 of `{"nonce","signature","signedMessage"}`. If it verifies and the wallet
holds an SGT, the record becomes `NOTCHv3` (v2 + `device_hash[32]` = `sha256("notch-sgt"|mint)`) and the limit is multiplied by **1.5**
(`SEEKER_MULTIPLIER`: both the 30% share and the first-timer cap; never past the 2000 hard cap). The mint itself never leaves the enclave.
No proof, or a valid proof with no SGT, is exactly the old behaviour (a plain 128 byte v2 record). A bad proof is refused (422).
One phone backs one wallet: the enclave refuses a phone another wallet uses (in memory and via the chain: `getDeviceOwner`), and the
program refuses it too (`DeviceLink` PDA `["device", device_hash]`, error `DeviceBound`). A wallet holding several phones' tokens binds the
first one nobody else uses. Tests: `test/device.test.js` (SGT reader stubbed), `enclave/scripts/sgt-real-read.mjs` (REAL mainnet read).
**Statement inbox path:** `POST /inbox/new` takes the same proof (`"device": {nonce, signature, signedMessage}` in the JSON body, or the
`x-notch-device` header). It is checked right then (the challenge is single use and lives 5 minutes; the address lives 14 days), a bad proof
is refused (401, no address issued), and the address remembers that it was proven. When the statement arrives the underwriter reads the
wallet's SGT (mainnet, read only): with a token the record is `NOTCHv3` with the device hash and the 1.5x limit; without one, an ordinary
v2 record and `seeker: false`. A Seeker who sends no proof gets no phone binding. An outage of the token lookup answers `503 {retry: true}`
and is not counted as a refusal (the address is not locked or spent). Tests: `test/inbox-device.test.js`, devnet e2e step 13.

### Statement parsing (security model)
Two layouts are read. The statement MTN **emails** on a `*170#` request (landscape table with drawn borders,
`TRANSACTION DATE | FROM ACCT | ... | OVA`, account number labelled `MSISDN:`) is read by `src/statement-email.js`:
cells come from the table borders, direction from which of FROM NO. / TO NO. is the account, and BAL BEFORE / BAL AFTER
check every row. Real one (2026-11-26, aggregates only): 30 days, 116 rows, 9 pages, 0 balance breaks. The other layout:

Layout is the REAL MTN MoMo statement (made with pdfmake; read from a real file on 2026-11-23): header block
(Account holder, Wallet number, From/To date), then a table repeated on every page:
`Date & Time | Payment Type | To/From | Account Name | Amount (+/-) | Transaction ID | Fees | Tax | Balance | Reference`,
newest row first, dates like `5 Nov 2026 14:32` (day not zero padded), cells that wrap onto extra lines.
- Columns come from the table's own header row; a row is a line whose **first column holds a date**, so a memo
  that wraps onto a new line (it stays in its own column) can never pass for a row. "Page N of M" closes a page's table.
- **Running-balance check** on every row: `balance(row) - balance(next older row) = amount - fees - tax`. Rows that
  break it are listed (row numbers only), their credits never count, and a table where more than 10% of the links
  break (a misread table) is refused. The real 90-day statement: 360 rows, 18 pages, 357 of 359 links hold (the two
  breaks are two credits missing from the statement itself).
- The amount is read only from the signed Amount column; the wallet number (identity) and holder name only from the
  header block, only from the value next to their label. The AI reader never sees raw phone numbers (see below).
- Each row has a key (transaction id + date + amount + balance); overlapping statements never double count a row.

### Income sorting: money in is not income (`src/income.js`)
Every credit gets one class. **Rules decide; free text (memo, counterparty name) can only LOWER a credit, never raise it**
(a sender can type "salary" in a memo). In order, first match wins:

| class | plain rule | counts |
| --- | --- | --- |
| `refund` | type/name/memo says reversal or refund, or it returns an earlier debit (same amount, same counterparty, 3 days) | no |
| `interest` | a system account named "Interest ..." | no |
| `betting` | bookmaker names (SportyBet, Betway, 1xBet ...), "Credit.Inv"/"Debit.Inv" gaming invoices | no |
| `loan_disbursement` | a lender (QwikLoan, Fido ...) or the word "loan" | no |
| `self_transfer` | the holder's own name (2+ name parts) in name/memo (own bank over GIPS, own other wallet), own savings/investment wallets (Yellosave `ysavedep`, trust/equities, susu) | no |
| `cash_deposit` | Payment Type CASH IN (a trader's takings, but cannot be told from funding yourself) | only under the cash rules below, at **50%** |
| `earned_income` | **structural**: from a system account (To/From holds no phone number) whose Account Name is on the payer list (Paystack, Flutterwave, Deel, Payoneer, Wise, Upwork, Stripe, PayPal, payroll/salary ...) or a payroll Payment Type | **100%** |
| `peer_transfer` | person to person (To/From holds a phone number) | only from a *regular* payer, at **50%** |
| `unknown` | anything else | no |
| `pass_through` | applied last: a credit of 100+ GHS (earned/peer/unknown, not cash: it has its own rule) followed within 48 h by debits of 90%+ of it (each debit used once, earliest credit first) | no |

**Cash rules** (steady cash deposits ARE a trader's income, but cash is the easiest thing to fake; every rule only lowers):
1. *Cycling*: a deposit is matched (oldest first, each debit used once, no minimum size, proportional) against money that
   leaves the wallet within 7 days AFTER it: cash-outs, person-to-person and other-network transfers, moves to the holder's
   own bank/name. A cash-out in the 7 days BEFORE it counts too (take cash out, put it back). Shops, bills and airtime are
   spending, not cycling. A move into a savings *product* (a system account named savings/trust/equities, no phone number)
   does not cycle: that money can only become cash again through this wallet, where a cash-out shows. Only the account name
   decides, never the memo (the borrower writes their own memos).
2. *Net cash*: cash-outs no deposit used up (waiting 8 days beats rule 1) come off what is left.
3. *Regular*: what is left must fall in at least 2 of the 3 thirty-day months, else nothing counts.
4. *Even*: one month counts for at most 2x the (lower) median month, so a token deposit cannot unlock a huge one.
The AI reader can never file a credit as cash (only the rules do); it can still drop one. Tests: `test/cash.test.js`.
Tuning lever: `cashOwnMoney` ('bank' default, 'all' strictest, 'none' what-if) in `finalizeIncome`.

*Regular payer* = the same counterparty paid in during at least two different calendar months. A one-off peer credit
counts 0. If only one regular payer exists, the share halves again (25%): one source is easy to fake with a second wallet.
Rows that fail the running-balance check, or sit in the future, never count.

**Behaviour signals** (computed in the enclave, never leave it): months with income (of the last 3 thirty-day buckets),
income regularity, average end-of-day balance, share of spend on betting, existing loan repayments. The limit
(`src/underwrite.js`) uses: counted income x 30% (cap 50 USDC for a first-timer), minus existing loan repayments first,
x (0.5 + 0.5 x regularity), x max(0, 1 - 2 x betting share). Average end-of-day balance is reported, not used yet.
Only the final limit leaves the enclave.

**AI reader (optional)** may only **downgrade**: it gets pseudonymised credit rows (phone numbers become P1, P2...,
long digit runs removed, the holder's name becomes HOLDER) and may say "this credit is really a loan / betting / own
money". Its answer is applied only if the row exists, the amount equals the row's amount and appears literally in the
PDF text, and the new class counts for strictly less than the rules' class. Anything else is dropped; on any error the
rules result stands. It can never raise a limit.

**Local-only check of a real statement:** `node enclave/scripts/local-real-check.mjs <statement.pdf> [--out]` prints
aggregates only (rows, balance-check rate, totals per class, signals, limit). No network, no AI reader; `--out` writes
the same numbers to `enclave/local-real-check.out.json` (git-ignored). Never commit a real statement.
Real 90-day Ghana statement (aggregates only): 70 credits / 42,985 GHS; 6 cash deposits = 23,467 GHS. Before the cash rules:
0 earned income, counted 1,847 GHS, limit **11.62 USDC**. After: 9,811 GHS of the cash left again within 7 days (cycling),
the other 13,346 GHS fell in all 3 months, counted 5,628 GHS (50%, evenness cap), counted income 7,475 GHS, limit **47.47 USDC**.
With every move into own savings also treated as cycling the limit would stay 11.62 (what-if printed by the script).

### Statement inbox ("MTN sends the statement straight to Notch")
`src/inbox.js`, `deploy/cloudflare/`. A wallet asks `POST /inbox/new {"wallet", ["ts","signature"], ["device"]}` (the optional Seeker proof is described above) and gets
`{address: "<code>@<NOTCH_INBOX_DOMAIN>", pollToken}`; the code is a random 50-bit id bound to that wallet inside the
enclave (max 3 open per wallet, 14-day life, single use). The borrower has MTN mail the statement there. A Cloudflare
Email Worker forwards the **raw** message to `POST /inbound` (headers `x-notch-inbound-secret`, `x-notch-rcpt`). The
enclave maps the address to the wallet, runs the normal pipeline, signs the record and keeps it; the wallet fetches it
with `GET /record/<wallet>` + header `x-notch-token` (`waiting | ready | refused | locked`).
- Unknown/expired/used/locked addresses are refused (404/410/429). A refused message does not spend a code; five lock it.
- **No redirect (security)**: `recipientRefusal` in `src/underwriter.js` ties each mail to the address it arrived at.
  - Provider signs `To`: the signed `To` must name that very address.
  - Provider does not sign `To` (MTN signs From, Date, Subject, Message-ID, Content-Type, MIME-Version): the signer must be
    trusted, the one `To` address must equal the envelope recipient (this code's address), the **signed** `Date` must be no
    earlier than the code's issue time and no later than now (2 minutes of clock skew each way), and the signed
    `Message-ID` and body hash are single use, as the code is.
  - Header facts are read from what the DKIM verifier hashed, never from a second parser, and a repeated From, To, Date,
    Message-ID or Content-Type header is refused (both closed real bypasses of the `To` check).
  - **Not covered, for an unsigned `To`**: someone holding a copy of another person's statement dated *after* their own
    code was issued (codes live 14 days) can rewrite `To` and claim it if they send it first. See "Statement ownership".
  - These refusals show their own message in the app, never "signature does not check out"; public status says `wrong_inbox`.
- Asking for a code "for" someone else's wallet gives you only a
  token that opens your own results. The wallet proof is REQUIRED (since the Supabase layer): an Ed25519 signature over
  `notch-inbox-v1|<wallet>|<ts>`, or a Supabase "Sign in with Solana" token as `Authorization: Bearer`. Only tests can skip it
  (`insecureAllowUnsignedForTests`). Public status rows (received, checking, limit posted, refused) and the hash of each
  record go to the `store` (memory by default, Supabase when configured): see [`../supabase/README.md`](../supabase/README.md).
- Honest limits: Cloudflare sees the mail in transit (DKIM stops forgery, not reading); state is in memory (a restart
  forgets open addresses); no domain is owned yet (`inbox.notch.invalid` placeholder). Rehearsal incl. devnet:
  `node enclave/scripts/e2e-inbox.mjs`.

### Real mail for free: one AgentMail mailbox (`src/agentmail-bridge.js`)
No domain needed. Set `NOTCH_INBOX_ADDRESS=notch-inbox@agentmail.to` and each wallet's address becomes
`notch-inbox+<code>@agentmail.to` (without it, `<code>@NOTCH_INBOX_DOMAIN` as above). With `AGENTMAIL_API_KEY` also set,
the demo server and the CVM server poll the mailbox every 10 s, download the raw message and run it through the same
`receive` path as `/inbound`. The same recipient rules apply (see "No redirect").
```
set -a; . ~/.config/notch/agentmail.env; set +a          # AGENTMAIL_API_KEY, never printed or committed
NOTCH_INBOX_ADDRESS=notch-inbox@agentmail.to NOTCH_LLM=off pnpm --dir app demo:enclave
node enclave/scripts/e2e-agentmail.mjs                   # live check: real send -> refused; synthetic fixture -> limit
```
- Bridge mail is checked against **real DNS** and the real source list, even on a demo server (whose other routes trust the test key).
- Optional: point an AgentMail `message.received` webhook at `POST /agentmail/webhook`. Its body is ignored; it only triggers a poll.
- Separate process instead (for `src/server.js`): `scripts/agentmail-bridge.mjs`, which posts to `/inbound` with `NOTCH_INBOUND_SECRET`.
- Only messages addressed to a code this process issued are downloaded. Nothing about a message is logged or written to disk.
  `NOTCH_AGENTMAIL_POLL_MS` changes the 10 s.

Honest limits:
- **AgentMail receives and keeps the statement** (so can whoever holds the API key). "Only the sealed computer reads it" is not true on this route.
- With the AI reader on, pseudonymised statement rows go to `NOTCH_LLM_URL`. Leave it off for real statements unless that endpoint is trusted.
- **Real MTN mail (one sample, 2026-11-26)**: DKIM passes as `mtn.com`, `To` is not signed, the `+` address arrived. Its PDF
  has a **different layout** (30 days, `MSISDN`, `FROM NO.`/`TO NO.`, `BAL BEFORE`/`BAL AFTER`) that `src/statement.js`
  cannot read yet, so it is still refused.
- The app treats the mailbox as a real mail domain, so the "Send a sample statement" button shows only on the local demo server.
- Forwarding a statement from your own mail does not work: `To` then names you, not the inbox address.

### The secret pepper in `id_hash` (required)
There are only about 10^9 phone numbers, so a plain `sha256("notch-msisdn"|number)` on chain (the public PDA `["identity", id_hash]`) can be
matched by hashing every number. The hash is therefore `sha256("notch-msisdn"|pepper|number)` with a secret pepper, and **a real server
refuses to start without one** (`src/pepper.js`; `src/server.js`, `src/cvm-server.js` and `app/scripts/demo-enclave.mjs`):
- Local / your own host: `NOTCH_ID_PEPPER` = at least 32 random characters (`openssl rand -hex 32`). Keep it secret. **Never change it**:
  a new pepper gives every number a new hash, so a number could back a second wallet and old lines would no longer be found.
- Phala CVM: the pepper is **derived inside the TEE** with dstack key derivation (path `notch/id-pepper/v1`, hashed again with a domain
  separator): stable across restarts and redeploys of the same app, never in an env var, never visible to the operator. An operator-supplied
  `NOTCH_ID_PEPPER` is ignored there on purpose, and `deploy/phala/build-compose.mjs` refuses to put the pepper (or the switch below) into the
  compose file. **Not verified on a live CVM yet** (nothing was deployed): the dstack `getKey` call is tested with a stub client only.
- Tests and demos only: `NOTCH_INSECURE_NO_PEPPER=1` starts without a pepper and prints a loud warning every time. Never set it for real borrowers.
Changing from no pepper to a pepper changes every `id_hash`: devnet lines made earlier are simply not matched any more (fine for test data).

### Not solved yet
- **Statement ownership**: a statement can be mailed to any address, and anyone holding someone else's statement
  could present it first and claim that number for their wallet. Needs a phone proof (SMS OTP to the number) before
  the binding, which the DKIM mail alone cannot give.
- Self-paid Earn payouts: anyone can create a sponsor and pay themselves. Earn proof needs a sponsor allowlist.

## Config (env)

| var | meaning |
| --- | --- |
| `NOTCH_SUPERTEAM_DOMAIN` | DKIM domain of Earn payout emails (default `superteam.fun`) |
| `NOTCH_INBOX_DOMAIN` | domain of the statement inbox addresses (default `inbox.notch.invalid`, a placeholder) |
| `NOTCH_INBOUND_SECRET` | shared secret of the Cloudflare worker; `/inbound` is disabled without it |
| `NOTCH_INBOX_ADDRESS` | shared mailbox `<local>@<domain>`: addresses become `<local>+<code>@<domain>` (wins over `NOTCH_INBOX_DOMAIN`) |
| `AGENTMAIL_API_KEY` | with `NOTCH_INBOX_ADDRESS`, polls that AgentMail inbox. Secret: env only |
| `NOTCH_STORE` | `memory` (default) or `supabase`: where public statement status goes |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | the live project (service key writes status; anon key checks "Sign in with Solana" tokens). Secrets: env only |
| `NOTCH_ID_PEPPER` | **required**: secret (>= 32 chars) mixed into the identity hash (see above); derived inside the TEE on Phala |
| `NOTCH_INSECURE_NO_PEPPER` | `1` = start without a pepper, tests/demos only, loud warning |
| `SOLANA_RPC_URL`, `NOTCH_PROGRAM_ID` | chain reads (credit history, identity links, Earn payout proof) |
| `NOTCH_USDC_MINT` | mint the Earn proof looks for (default mainnet USDC) |
| `NOTCH_LLM_URL`, `NOTCH_LLM_MODEL`, `NOTCH_LLM_KEY` | AI reader (must be a confidential endpoint, see `src/llm-extract.js`) |

## SOURCES

Status: **modelled** = a real message was seen second-hand and the format is modelled here; **unverified until a
real sample** = the domain comes from DNS evidence only (DMARC and DKIM selectors, see `RESEARCH-CORE.md`), the email
format has never been seen, and nothing below should be trusted for real money until a raw `.eml` is checked.

| Source | Trusted `d=` | Reader | Evidence | Status |
| --- | --- | --- | --- | --- |
| MTN MoMo Ghana | `mtn.com` (**not** `mtn.com.gh`: no MX, no DMARC) | statement PDF, phone-number identity | monthly statement on request from `ServiceMMStatement.GH@mtn.com`, PDF `MomoStatementReport.pdf` (secondary sample, Scribd). DMARC `p=reject`. SPF includes Oracle email delivery, so the signer could be Oracle with `d=mtn.com` | layout **confirmed from a real PDF (Nov 23)**; the real `.eml` (signing domain, headers) is still unseen |
| Superteam Earn | `superteam.fun` (configurable) | email amount + on-chain USDC proof | Earn queues payment emails through Resend; `resend._domainkey.superteam.fun` exists; DMARC only `p=none`; template wording unknown | unverified until a real sample |
| Wise | `wise.com` | email body | DMARC `p=reject`; selectors `google`, `s1`, `s2`, `mandrill`, `k1` | unverified until a real sample |
| Payoneer | `payoneer.com` | email body | DMARC `p=reject`; selectors `selector1/2`, `mandrill` | unverified until a real sample |
| Deel | `deel.com` | email body | DMARC `p=reject`; selectors `s1`, `s2`, `google`, `mail` | unverified until a real sample |
| Upwork | `upwork.com` | email body | DMARC `p=reject`; selectors not probed | unverified until a real sample |

Removed: `mtn.com.gh`. Not yet listed (no evidence of signed income email): Telecel Cash, AirtelTigo Money, M-Pesa
(statement is password-protected, password arrives by SMS: refused today), Ghana banks.

## Needs a real sample before real use
1. One raw MoMo statement `.eml` (headers: `d=`, selector, whether `h=` covers `content-type`, From local part) and
   its PDF. The PDF layout is now known (real statement, Nov 23); still unseen: the email headers (`d=`, selector,
   whether `h=` covers `to` and `content-type`, From local part) and whether the PDF can arrive password-protected.
   Layout knowledge lives in `src/statement.js` (`COLUMN_WORDS`, header labels) and the class rules in `src/income.js`.
2. One Superteam Earn payout email (sender domain, wording, whether it quotes a transaction signature).
3. One email each from Wise, Payoneer, Deel, Upwork (`d=`, wording, amount and currency format).

## Running in a TDX confidential VM (Phala Cloud)

`src/cvm-server.js` is the same underwriter inside a Phala/dstack TDX VM: key generated at boot in the TD and never
written out, `GET /attestation?nonce=` returns a real TDX quote binding the key (`attest.js`), and `DEMO_FIXTURES=1`
(a build flag, visible in the attested compose) trusts the synthetic DKIM test key. Verify from outside with
`scripts/verify-attestation.mjs`; end-to-end with `scripts/e2e-phala.mjs`. Deployment, switching the devnet key and
the honest list of what is still mocked: `../deploy/phala/README.md`. The AI reader still calls a hosted endpoint
outside the TEE; `NOTCH_LLM_IN_TEE=1` (declared, not verified) is reported in `/attestation` for when it moves inside.
