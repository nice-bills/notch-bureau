// Emulator QA fixes (Nov 26): money rounding, plain share-price words, the inbox request retry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUsdc } from '../src/amount';

describe('formatUsdc round', () => {
  it('cuts by default (a limit never reads high)', () => {
    expect(formatUsdc(9_999_999n, { max: 2 })).toBe('9.99');
  });
  it('rounds what you hold to the nearest cent', () => {
    expect(formatUsdc(9_999_999n, { max: 2, round: true })).toBe('10.00');
    expect(formatUsdc(9_994_999n, { max: 2, round: true })).toBe('9.99');
    expect(formatUsdc(5_005_000n, { max: 2, round: true })).toBe('5.01');
  });
});

describe('callWithRetry', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('retries a network failure, then succeeds', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const { callWithRetry } = await import('../src/enclave');
    const r = await callWithRetry('/inbox/new', { method: 'POST' }, [1]);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('does not retry an HTTP answer', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"ok":false}', { status: 401 }));
    vi.stubGlobal('fetch', f);
    const { callWithRetry } = await import('../src/enclave');
    expect((await callWithRetry('/inbox/new', undefined, [1, 1])).status).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('gives up after the last wait with the plain message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { callWithRetry } = await import('../src/enclave');
    await expect(callWithRetry('/inbox/new', undefined, [1, 1])).rejects.toThrow(/Could not reach the sealed computer/);
  });
});
