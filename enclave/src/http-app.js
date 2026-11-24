import http from 'node:http';
import bs58 from 'bs58';
import { Inbox, handleInbox } from './inbox.js';

const MAX = 5 * 1024 * 1024;

// The local underwriter's HTTP surface (also what the end-to-end test starts, with a fixture-trusting Underwriter).
export function createApp(u, inbox = new Inbox()) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-wallet, x-notch-token, authorization' });
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    try {
      if (await handleInbox(inbox, u, req, url, send)) return;
    } catch (e) {
      return send(500, { ok: false, reason: e.message });
    }
    if (req.method === 'GET' && req.url === '/attestation') {
      // Placeholder until TDX: the real response is the Confidential Compute quote binding this key.
      return send(200, {
        underwriter: u.publicKey,
        mode: 'local-dev',
        extraction: u.llm ? { mode: 'llm', model: u.llm.model } : { mode: 'rules' },
        note: 'not attested; TDX quote replaces this',
      });
    }
    if (req.method === 'POST' && req.url === '/underwrite') {
      const wallet = req.headers['x-wallet'];
      try {
        bs58.decode(String(wallet || ''));
      } catch {
        return send(400, { ok: false, reason: 'x-wallet header must be a base58 address' });
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX) return send(413, { ok: false, reason: 'email too large' });
        chunks.push(c);
      }
      try {
        const r = await u.submit(Buffer.concat(chunks), String(wallet));
        return send(r.ok ? 200 : 422, r);
      } catch (e) {
        return send(500, { ok: false, reason: e.message });
      }
    }
    send(404, { ok: false, reason: 'not found' });
  });
}
