# Notch statement inbox: Cloudflare Email Worker

MTN mails the MoMo statement to `<code>@<your-inbox-domain>`. Cloudflare Email Routing hands the message to
`email-worker.js`, which POSTs the **raw** message to the enclave's `/inbound`. The enclave checks DKIM, reads the
PDF, sorts income, signs the limit, and keeps it for the wallet to fetch.

## Status: not deployed. No domain is owned yet.
Nothing here has run on Cloudflare. The enclave side is tested locally (`enclave/test/inbox.test.js`,
`enclave/test/cloudflare-worker.test.js`, `enclave/scripts/e2e-inbox.mjs`). Until a domain exists the enclave hands out
addresses on `inbox.notch.invalid` (it never resolves; the product shows it as "not set up yet").

## Setup (when you have a domain)
1. Add the domain to Cloudflare (DNS on Cloudflare), Email Routing -> enable, Cloudflare adds the MX/SPF records.
2. Pick the inbox domain (a subdomain like `inbox.example.com` is fine) and set on the enclave:
   `NOTCH_INBOX_DOMAIN=inbox.example.com` and `NOTCH_INBOUND_SECRET=<long random string>`.
   (Phala: add both as encrypted environment variables; they are not in the measured compose file.)
3. Deploy the worker: `cd deploy/cloudflare && npx wrangler deploy`, then
   `npx wrangler secret put NOTCH_INBOUND_SECRET` (same value) and set `NOTCH_INBOUND_URL` in `wrangler.toml`.
4. Email Routing -> Routing rules -> **Catch-all** -> action "Send to a Worker" -> `notch-inbox`.
   Every `anything@inbox.example.com` now reaches the worker; the enclave decides which codes are real.
5. Smoke test the real path: `POST /inbox/new {"wallet": "<address>"}`, then email anything to the address. A bounce
   "address cannot take this message (422)" proves routing -> worker -> enclave works (the mail is not a real statement).
   The local rehearsal of the whole flow, worker code included, is `node enclave/scripts/e2e-inbox.mjs` (devnet).

## What the worker does and does not do
- Forwards bytes unchanged (a re-encoded message would break MTN's DKIM signature). Bounces on 4xx, retries on 5xx.
- Sends the SMTP recipient in `x-notch-rcpt`. The enclave does not rely on it alone: the **DKIM-signed `To` header** of
  MTN's mail must name the same address, so a statement meant for one inbox cannot be replayed into another.
- Logs nothing.

## Honest limits
- **Cloudflare can read the statement in transit** (it terminates the mail). DKIM stops anyone from forging or editing a
  statement, but it does not hide it. Anyone who needs the content hidden from Cloudflare must use the manual path (the
  borrower uploads the `.eml` straight to the enclave over HTTPS: `POST /underwrite`).
- The worker -> enclave hop is HTTPS to the enclave's public URL; the shared secret only proves the caller is our worker.
- MTN may not allow typing an arbitrary email address for statements, or may mail from a different signing domain
  than modelled (`mtn.com`). Confirm with one real `.eml` (see `enclave/README.md`, "Needs a real sample").
- Inbox state (codes, results) is in the enclave's memory: a restart forgets open addresses, the borrower asks again.
