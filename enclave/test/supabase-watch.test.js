// The phone must not depend on catching every Realtime event: right after SUBSCRIBED it reads the current row.
// A fake Supabase client plays the bad case seen on the live project (a cold channel that misses the first events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchJobs, describe, isDone } from '../scripts/supabase-watch.mjs';

const W = 'Wallet1111111111111111111111111111111111111';
const row = (status, at, code = 'abcdefghij', extra = {}) => ({ code, wallet: W, status, reason_code: null, updated_at: new Date(at).toISOString(), ...extra });

// events: what Realtime delivers AFTER the subscription is live. current: what a select returns.
function fakeClient({ current = [], events = [], dropEvents = false, selectError = null, subscribeStatus = 'SUBSCRIBED' } = {}) {
  const log = [];
  let handler;
  const c = {
    log,
    channel(name) {
      log.push(`channel ${name}`);
      const ch = {
        on(_type, filter, fn) { log.push(`on ${filter.table} ${filter.filter}`); handler = fn; return ch; },
        subscribe(cb) {
          log.push('subscribe');
          setTimeout(async () => {
            if (subscribeStatus !== 'SUBSCRIBED') return cb(subscribeStatus, new Error('channel failed'));
            log.push('SUBSCRIBED');
            const p = cb('SUBSCRIBED');
            if (!dropEvents) for (const e of events) setTimeout(() => handler({ new: e }), 5);
            await p;
          }, 1);
          return ch;
        },
      };
      return ch;
    },
    from(t) {
      log.push(`select ${t}`);
      const q = { select: () => q, eq: (k, v) => { log.push(`eq ${k}=${v}`); return q; }, order: () => Promise.resolve({ data: selectError ? null : current, error: selectError }) };
      return q;
    },
  };
  return c;
}

test('the current row is read right after SUBSCRIBED: a lost event cannot leave the phone stuck', async () => {
  // the whole journey already happened and Realtime delivered NOTHING (the cold-channel miss)
  const seen = [];
  const sb = fakeClient({ current: [row('limit_posted', 3000)], dropEvents: true });
  await watchJobs({ supabase: sb, wallet: W, untilDone: true, onRow: (r, from) => seen.push([r.status, from]) });
  assert.deepEqual(seen, [['limit_posted', 'read']]);
  const i = sb.log.indexOf('SUBSCRIBED');
  assert.ok(i > 0 && sb.log.slice(i).some((l) => l === 'select inbox_jobs'), 'the select happens after the channel is live');
  assert.ok(sb.log.includes(`eq wallet=${W}`), 'only this wallet');
});

test('events after the read still arrive; the phone shows the latest, and a late older row never moves it backwards', async () => {
  const seen = [];
  const sb = fakeClient({ current: [row('received', 1000)], events: [row('checking', 2000), row('limit_posted', 3000), row('checking', 2000)] });
  await watchJobs({ supabase: sb, wallet: W, untilDone: true, onRow: (r, from) => seen.push([r.status, from]) });
  assert.deepEqual(seen, [['received', 'read'], ['checking', 'event'], ['limit_posted', 'event']]);
});

test('works with no events at all, and with two codes at once; a refused job also finishes it', async () => {
  const seen = [];
  const sb = fakeClient({ current: [row('checking', 1000, 'aaaaaaaaaa'), row('refused', 2000, 'bbbbbbbbbb', { reason_code: 'no_income' })] });
  await watchJobs({ supabase: sb, wallet: W, untilDone: true, onRow: (r) => seen.push(`${r.code[0]}:${describe(r)}`) });
  assert.deepEqual(seen, ['a:checking it', 'b:refused (no_income)']);
  assert.equal(isDone(row('checking', 1)), false);
});

test('a channel error rejects, and so does a failed read of the current row', async () => {
  await assert.rejects(watchJobs({ supabase: fakeClient({ subscribeStatus: 'CHANNEL_ERROR' }), wallet: W, onRow: () => {} }), /channel failed/);
  await assert.rejects(watchJobs({ supabase: fakeClient({ selectError: { message: 'permission denied' } }), wallet: W, onRow: () => {} }), /could not read the current status: permission denied/);
});

test('without untilDone it keeps running until aborted', async () => {
  const ac = new AbortController();
  const seen = [];
  const sb = fakeClient({ current: [row('limit_posted', 3000)] });
  const p = watchJobs({ supabase: sb, wallet: W, onRow: (r) => seen.push(r.status), signal: ac.signal });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, ['limit_posted']);
  ac.abort();
  await p;
});
