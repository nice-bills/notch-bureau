// The secret "pepper" mixed into the MoMo-number hash (statement.js identityHash). The hash is public on chain
// (PDA ["identity", id_hash]); a phone number has only ~10^9 values, so WITHOUT a secret anyone can hash every Ghanaian
// number and learn which numbers have a credit line. With a secret pepper they cannot.
//
//   * A real server REFUSES to start without a pepper (`requirePepper`), except under the explicit flag
//     NOTCH_INSECURE_NO_PEPPER=1, which prints a loud warning every time. The flag is for tests and demos ONLY.
//   * Outside a TEE the operator supplies NOTCH_ID_PEPPER (>= 32 characters, random, kept secret, never changed: a new
//     pepper gives every number a new hash, so one number could back a second wallet).
//   * Inside the Phala CVM the pepper is DERIVED INSIDE THE TEE from the app's dstack key (`pepperFromDstack`), like the
//     signing key never leaves it: it is stable across restarts and redeploys of the same app, no operator ever sees it,
//     and an operator-supplied NOTCH_ID_PEPPER is ignored there on purpose.
import crypto from 'node:crypto';

export const MIN_PEPPER_CHARS = 32;
export const INSECURE_FLAG = 'NOTCH_INSECURE_NO_PEPPER';
export const DSTACK_PEPPER_PATH = 'notch/id-pepper/v1';

export class PepperError extends Error {}

const bar = '#'.repeat(78);
export const insecureBanner = () => `\n${bar}\n#  WARNING: ${INSECURE_FLAG}=1. NO SECRET PEPPER: phone-number hashes on chain can be brute-forced.\n#  Anyone can hash every possible number and match it to the public identity accounts.\n#  Tests and demos ONLY. Never use this for real borrowers.\n${bar}\n`;

// -> the pepper string. Throws PepperError when there is none and the insecure flag is not set.
export function requirePepper(env = process.env, { warn = (m) => console.error(m) } = {}) {
  const p = String(env.NOTCH_ID_PEPPER || '');
  if (p) {
    if (p.length < MIN_PEPPER_CHARS) throw new PepperError(`NOTCH_ID_PEPPER is too short (${p.length} characters): use at least ${MIN_PEPPER_CHARS} random characters, e.g. \`openssl rand -hex 32\``);
    return p;
  }
  if (env[INSECURE_FLAG] === '1') { warn(insecureBanner()); return ''; }
  throw new PepperError(`refusing to start: NOTCH_ID_PEPPER is not set. It is the secret that stops the public phone-number hashes from being brute-forced. Set it (\`openssl rand -hex 32\`, keep it secret, never change it), or for a test/demo ONLY set ${INSECURE_FLAG}=1.`);
}

// Same, for a server that must not die with a stack trace.
export function pepperOrExit(env = process.env) {
  try { return requirePepper(env); } catch (e) {
    if (!(e instanceof PepperError)) throw e;
    console.error(`notch: ${e.message}`);
    process.exit(1);
  }
}

// dstack key derivation: the guest agent derives a key from the app's key tree and a path; the same app and path always
// give the same key, in every CVM instance of that app, and nobody outside the TEE sees it. `clients` is an array of
// dstack clients (v0 then v1), tried in order, because 0.6.x guest agents may answer only one of the two routes.
export async function pepperFromDstack(clients) {
  let last;
  for (const c of clients) {
    try {
      const r = await c.getKey(DSTACK_PEPPER_PATH, 'notch-id-pepper');
      const raw = r?.key ?? r;
      const bytes = typeof raw === 'string' ? Buffer.from(raw, /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? 'hex' : 'utf8') : Buffer.from(raw || []);
      if (bytes.length < 16) throw new Error('dstack returned a short key');
      // domain-separated again, so the raw dstack key itself is never what is mixed into a public hash
      return crypto.createHash('sha256').update('notch-id-pepper-v1|').update(bytes).digest('hex');
    } catch (e) { last = e; }
  }
  throw new PepperError(`could not derive the identity pepper inside the TEE (${String(last?.message || last)})`);
}

// The CVM's rule: derive it in the TEE, or do not start. There is NO insecure fallback here: an operator could set any
// env var through Phala's encrypted settings, so the CVM ignores both NOTCH_ID_PEPPER and the insecure flag.
export async function cvmPepper(env, clients, { warn = (m) => console.error(m) } = {}) {
  if (env.NOTCH_ID_PEPPER) warn('notch: NOTCH_ID_PEPPER is ignored inside the CVM: the pepper is derived inside the TEE and never leaves it');
  if (env[INSECURE_FLAG]) warn(`notch: ${INSECURE_FLAG} is ignored inside the CVM: it never starts without the TEE-derived pepper`);
  try {
    return await pepperFromDstack(clients());
  } catch (e) {
    throw new PepperError(`refusing to start: ${e.message}`);
  }
}
