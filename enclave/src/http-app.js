import http from 'node:http';
import { Inbox, handleInbox } from './inbox.js';
import { handleDevice } from './device-http.js';
import { handleUnderwrite } from './underwrite-http.js';

// The local underwriter's HTTP surface (also what the end-to-end test starts, with a fixture-trusting Underwriter).
export function createApp(u, inbox = new Inbox(), opts = {}) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-wallet, x-notch-token, x-notch-device, x-notch-ts, x-notch-sig, authorization' });
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    try {
      if (await handleInbox(inbox, u, req, url, send)) return;
    } catch (e) {
      return send(500, { ok: false, reason: e.message });
    }
    if (await handleDevice(u, req, url, send)) return;
    if (req.method === 'GET' && req.url === '/attestation') {
      // Placeholder until TDX: the real response is the Confidential Compute quote binding this key.
      return send(200, {
        underwriter: u.publicKey,
        mode: 'local-dev',
        extraction: u.llm ? { mode: 'llm', model: u.llm.model } : { mode: 'rules' },
        note: 'not attested; TDX quote replaces this',
      });
    }
    if (await handleUnderwrite(u, req, url, send, opts)) return;
    send(404, { ok: false, reason: 'not found' });
  });
}
