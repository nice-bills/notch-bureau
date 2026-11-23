import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bs58 from 'bs58';
import { composeHashFromEvents, parseTdxQuote, replayRtmr, reportDataFor } from '../src/attest.js';

// A real response from the live Phala CVM (Intel TDX, dstack), captured with nonce aabbcc.
const att = JSON.parse(fs.readFileSync(new URL('./fixtures/phala-attestation.json', import.meta.url), 'utf8'));

test('real TDX quote parses and report_data binds the underwriter key and nonce', () => {
  const q = parseTdxQuote(att.quote);
  assert.equal(q.version, 4);
  assert.equal(q.teeType, 0x81);
  const want = reportDataFor(bs58.decode(att.underwriter), Buffer.from(att.nonce, 'hex')).toString('hex');
  assert.equal(q.reportData, want);
});

test('report_data changes with the key and with the nonce', () => {
  const k = bs58.decode(att.underwriter);
  const base = reportDataFor(k, Buffer.from('aabbcc', 'hex')).toString('hex');
  assert.notEqual(base, reportDataFor(k, Buffer.from('aabbcd', 'hex')).toString('hex'));
  assert.notEqual(base, reportDataFor(Buffer.alloc(32, 1), Buffer.from('aabbcc', 'hex')).toString('hex'));
  assert.notEqual(base, reportDataFor(k).toString('hex'));
  assert.equal(reportDataFor(k).length, 64);
});

test('RTMR3 replayed from the event log equals RTMR3 in the signed quote', () => {
  const q = parseTdxQuote(att.quote);
  assert.equal(replayRtmr(att.event_log, 3), q.rtmr3);
});

test('tampering with any RTMR3 event breaks the replay', () => {
  const q = parseTdxQuote(att.quote);
  const events = JSON.parse(att.event_log);
  const i = events.findIndex((e) => e.imr === 3 && e.event === 'compose-hash');
  events[i].digest = events[i].digest.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.notEqual(replayRtmr(events, 3), q.rtmr3);
});

test('compose-hash is read from the RTMR3 event log', () => {
  assert.equal(composeHashFromEvents(att.event_log), att.compose_hash);
});

test('a non-TDX blob is rejected', () => {
  assert.throws(() => parseTdxQuote(Buffer.alloc(700)), /not a TDX v4 quote/);
  assert.throws(() => parseTdxQuote('00'), /too short/);
});
