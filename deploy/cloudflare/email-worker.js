// Cloudflare Email Worker: forwards every message sent to <code>@<your inbox domain> to the Notch enclave, UNCHANGED.
//
//   MTN --email--> Cloudflare Email Routing --> this Worker --HTTPS POST /inbound--> Notch enclave
//
// The worker adds no logic of its own. It must not touch the message: the DKIM signature MTN put on it covers the
// headers and every byte of the body (the PDF included), and the enclave verifies it. It sends:
//   body                          the raw RFC 822 message, byte for byte
//   x-notch-rcpt                  the address the mail was delivered to (the enclave also checks the SIGNED To header)
//   x-notch-inbound-secret        shared secret (Worker secret NOTCH_INBOUND_SECRET == enclave NOTCH_INBOUND_SECRET)
//
// Bindings: NOTCH_INBOUND_URL (plain var, e.g. https://<enclave-host>/inbound), NOTCH_INBOUND_SECRET (secret).
// Nothing is logged: not the sender, not the recipient, not the body.
export const MAX_BYTES = 5 * 1024 * 1024; // the enclave refuses more

export default {
  async email(message, env) {
    if (!env.NOTCH_INBOUND_URL || !env.NOTCH_INBOUND_SECRET) {
      message.setReject('inbox not configured');
      return;
    }
    if (message.rawSize > MAX_BYTES) {
      message.setReject('message too large');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(env.NOTCH_INBOUND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-notch-rcpt': message.to,
        'x-notch-inbound-secret': env.NOTCH_INBOUND_SECRET,
      },
      body: raw,
    });
    if (res.ok) return; // accepted: a signed limit is waiting for the wallet
    // 404 unknown address, 410 used/expired, 429 locked, 422 refused statement: bounce, so a wrong mail is not silent.
    if (res.status >= 400 && res.status < 500) {
      message.setReject(`address cannot take this message (${res.status})`);
      return;
    }
    throw new Error(`enclave answered ${res.status}`); // 5xx: let Cloudflare treat it as a temporary failure
  },
};
