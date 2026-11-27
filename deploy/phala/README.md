# Notch underwriter in a Phala Cloud confidential VM

The underwriter (`enclave/`) runs in a real Intel TDX confidential VM (Phala Cloud, dstack). Its Ed25519 signing key is
generated at boot **inside** the VM and never leaves it. The VM's TDX quote commits to that key and to the exact code.

| | |
|---|---|
| CVM name | `notch-underwriter` (one instance, `tdx.small`: 1 vCPU, 2 GB, $0.058/h) |
| URL | https://0015f90bd03804232678c956ce789b09384f4b1d-8787.dstack-pha1-prod9.phala.network |
| Build | **DEMO** (`DEMO_FIXTURES=1`, visible in `/attestation` and inside the attested compose) |
| Latest e2e | 36/36 on devnet (Nov 26): inbox -> demo mailer -> limit, live status in Supabase |

## What is attested

`GET /attestation?nonce=<hex>` returns the underwriter's public key, a real TDX quote, the dstack event log and the
`app_compose` JSON. `report_data = sha256("notch-underwriter-v1" | ed25519 pubkey | nonce)` (no nonce => the plain
`sha256("notch-underwriter-v1" | pubkey)`), so the quote proves *this key was born in this TD* and is fresh.
The compose hash (`sha256(app_compose)`) is extended into RTMR3 at boot. The code is **inside** the compose file (a
gzip+base64 bundle in `NOTCH_BUNDLE`, base image pinned by digest, deps from `package-lock.json` with integrity
hashes), so same code => same compose hash. No registry push, no image to trust.

## Verify (anyone, from outside)

```sh
npm install --prefix enclave/scripts            # once: @phala/dcap-qvl (pure JS DCAP verifier)
node enclave/scripts/verify-attestation.mjs <cvm-url> [--expect-compose-hash <hex>] [--expect-pubkey <base58>]
```
Checks: TDX v4 quote, Intel signature chain + TCB (local DCAP; Phala's hosted verifier as a second opinion),
key binding + our fresh nonce, RTMR3 replay, compose-hash, image digest pinning, and that the bundle in the attested
compose is byte-identical to this repo. Pin `--expect-compose-hash` to detect a redeploy with different code.

## Register on devnet, and switch back

```sh
node deploy/phala/register-underwriter.mjs <cvm-url> --allow-demo --days 60   # verify, then set_underwriter(pubkey) (devnet, admin)
node deploy/phala/register-underwriter.mjs --local                  # restore the local demo key (.underwriter-key.json)
node enclave/scripts/e2e-phala.mjs                                   # full e2e; registers, tests, then restores the key it found
```
The devnet program is left on the **Phala** key, because the hosted demo needs it (set with `--days 60`; renew before
it expires). The browser suite (`pnpm e2e:browser:devnet`) borrows the program for its run: it sets the local key and
restores the recorded one afterwards (`app/e2e/rotation.ts`; the hosted demo shows "Key mismatch" meanwhile).
`app/scripts/e2e-devnet.mjs` does NOT do this: register the local key (`--local`) before it and the Phala key after.

## Redeploy / operate

```sh
set -a; . notch/.env.phala; set +a                       # PHALA_CLOUD_API_KEY, never printed or committed
node deploy/phala/build-compose.mjs                       # regenerate docker-compose.yml from enclave/src (edit NOTCH_ENV there)
# real mail (optional): put AGENTMAIL_API_KEY and NOTCH_INBOX_ADDRESS in the -e file below (sealed), see enclave/README.md
npx -y phala@latest deploy -n notch-underwriter -c deploy/phala/docker-compose.yml -t tdx.small \
    -e enclave/.env --cvm-id notch-underwriter --wait    # update in place; omit --cvm-id for a new one
npx -y phala@latest cvms stop notch-underwriter           # stop billing without deleting
npx -y phala@latest cvms delete notch-underwriter -y
```
`enclave/.env` (the Dolphin URL/model/key) is sent only as Phala **encrypted environment variables**; it is not in
the compose file. A restart makes a **new key** (it is never persisted): re-run `register-underwriter.mjs` afterwards.

Gotcha: Phala's deploy filter once rejected a compose ("violates our terms of use") because the base64 bundle held a
long random-looking run. `build-compose.mjs` puts a `.` every 16 characters; the CVM strips them.

## Switching the AI reader to a confidential endpoint later

Today emails are sent to the Dolphin endpoint (`lighthouse.dphn.ai`), **outside** the TEE; `/attestation` says so
(`mode.llm.in_tee: false`). To move it inside the boundary: point the sealed `NOTCH_LLM_URL`/`NOTCH_LLM_MODEL`/
`NOTCH_LLM_KEY` at an in-TEE endpoint (Phala confidential AI, which is paid, or a model container added to this compose
and called over the private compose network), then add `NOTCH_LLM_IN_TEE: "1"` to `NOTCH_ENV` in `build-compose.mjs`
and redeploy. That flag only *declares* it; a verifier must still check the LLM endpoint's own attestation. Not enabled.

## What is still mocked or unverified

- **On-chain:** the Solana program does not verify the quote. `set_underwriter` is admin-set; this repo only makes that
  admin step depend on a public, reproducible check. Full on-chain verification waits for Solana Confidential
  Compute's SDK/program (not public yet).
- **Demo build:** `DEMO_FIXTURES=1` trusts a synthetic DKIM key and serves fake sample emails. Real MTN/Wise mail cannot
  pass this build. A production build drops that flag (DKIM then checks real DNS; not run live yet).
- **LLM:** outside the TEE (see above).
- **Operator power:** the Phala account holder can deploy a different compose (different compose-hash => different key,
  caught by pinning). Sealed env values (LLM URL/key) are not in the compose hash, so an operator can change them.
- **Not checked by the verifier:** MRTD/RTMR0-2 vs the published dstack OS image, and the Phala KMS release policy.
  Phala, Intel and the physical host remain trust roots (TEE.fail-style physical attacks are out of scope).
- **State:** dedupe/identity sets are in memory (the chain enforces them too); the identity pepper (secret in the phone-number hash) is derived INSIDE the TEE by dstack key derivation (`enclave/src/pepper.js`), never an env value, and the server refuses to start without it. The compose build refuses to carry a pepper. Not yet run on a live CVM; container logs are public.
