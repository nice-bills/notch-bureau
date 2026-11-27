// Performance probe, not a pass/fail test. Runs only with PERF=1:
//   PERF=1 NOTCH_LLM=off pnpm e2e -- e2e/perf.spec.ts
// Phone size (390x844), CPU throttled 4x (a mid-range Android), real app on the local chain.
// Prints one JSON line per scenario; results go into app/PERF.md by hand.
import { test, type CDPSession, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { connectWallet, fundedWallet, openSession } from './app.ts';

test.skip(!process.env.PERF, 'set PERF=1 to run the performance probe');

const SOL = (n: number) => BigInt(Math.round(n * 1e9));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const out: Record<string, unknown>[] = [];

type M = Record<string, number>;
async function metrics(cdp: CDPSession): Promise<M> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Install frame + long-task + event-timing recorders in the page. */
async function arm(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __p: { frames: number[]; long: number[]; events: { name: string; d: number }[]; on: boolean } };
    w.__p = { frames: [], long: [], events: [], on: true };
    let last = performance.now();
    const tick = (t: number) => { if (!w.__p.on) return; w.__p.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.__p.on) w.__p.long.push(e.duration); }).observe({ type: 'longtask' });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (w.__p.on) w.__p.events.push({ name: e.name, d: e.duration }); })
      .observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  });
}
async function collect(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __p: { frames: number[]; long: number[]; events: { name: string; d: number }[]; on: boolean } };
    w.__p.on = false;
    const f = w.__p.frames.slice(1);
    const sorted = [...f].sort((a, b) => a - b);
    const ev = w.__p.events.filter((e) => /pointer|click|key|mouse/.test(e.name));
    return {
      frames: f.length,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxFrameMs: Math.round(sorted[sorted.length - 1] ?? 0),
      jankFrames: f.filter((d) => d > 50).length, // > 3 frames missed at 60 Hz
      longTasks: w.__p.long.length,
      longTaskMs: Math.round(w.__p.long.reduce((a, b) => a + b, 0)),
      maxInputMs: Math.round(Math.max(0, ...ev.map((e) => e.d))),
    };
  });
}
async function measure(name: string, page: Page, cdp: CDPSession, fn: () => Promise<void>) {
  await arm(page);
  const m0 = await metrics(cdp);
  const t0 = Date.now();
  await fn();
  await page.waitForTimeout(300);
  const m1 = await metrics(cdp);
  const r = await collect(page);
  const d = (k: string) => Math.round((m1[k] - m0[k]) * (k.endsWith('Duration') ? 1000 : 1));
  const row = {
    name, wallMs: Date.now() - t0, ...r,
    styleRecalcs: d('RecalcStyleCount'), styleMs: d('RecalcStyleDuration'),
    layouts: d('LayoutCount'), layoutMs: d('LayoutDuration'), scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'),
  };
  out.push(row);
  console.log('PERF ' + JSON.stringify(row));
}

test('perf probe (4x CPU, 390x844)', async ({ browser }) => {
  test.setTimeout(600_000);
  const w = await fundedWallet(SOL(0.02), USDC(20));
  const s = await openSession(browser, w, { phone: true });
  const { page } = s;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // ---- first load, cold cache ----
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  const t0 = Date.now();
  await page.goto('/', { waitUntil: 'load' });
  await page.getByRole('heading', { name: /Borrow against your income/ }).waitFor();
  const load = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const sum = (f: (r: PerformanceResourceTiming) => boolean) => Math.round(res.filter(f).reduce((a, r) => a + (r.encodedBodySize || r.transferSize), 0) / 1024);
    const lcp = await new Promise<number>((r) => new PerformanceObserver((l) => { const e = l.getEntries(); r(Math.round(e[e.length - 1].startTime)); }).observe({ type: 'largest-contentful-paint', buffered: true }));
    return {
      fcpMs: paint['first-contentful-paint'], lcpMs: lcp, domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      jsKB: sum((r) => /\.(m?js|tsx?)(\?|$)/.test(r.name) || r.initiatorType === 'script'), fontKB: sum((r) => /\.woff2?/.test(r.name)),
      cssKB: sum((r) => /\.css/.test(r.name)), requests: res.length,
      pollarLoaded: res.some((r) => /@pollar|pollar\.xyz/i.test(r.name)), supabaseLoaded: res.some((r) => /@supabase|supabase\.co/i.test(r.name)),
    };
  });
  out.push({ name: 'load', wallMs: Date.now() - t0, ...load });
  console.log('PERF ' + JSON.stringify({ name: 'load', ...load }));

  // ---- light: pointer sweep over the welcome screen (tilt / rim light) ----
  await measure('pointer-sweep (60 moves)', page, cdp, async () => {
    for (let i = 0; i < 60; i++) await page.mouse.move(20 + (i * 6) % 360, 100 + (i * 11) % 700);
  });

  // ---- connect, then get a limit so Home / Borrow have real content ----
  await connectWallet(page, w);
  await page.getByRole('button', { name: 'Get my limit' }).click();
  await page.getByRole('button', { name: 'Get my inbox address' }).click();
  await page.getByTestId('inbox-address').waitFor();
  await page.getByRole('button', { name: 'Send a sample statement (demo)' }).click();
  await page.getByRole('button', { name: 'Post my limit' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Post my limit' }).click();
  await page.getByRole('button', { name: 'Start borrowing' }).click({ timeout: 90_000 });
  await page.getByTestId('available').waitFor();
  await page.waitForTimeout(1000);

  await measure('scroll home (wheel, 2s)', page, cdp, async () => {
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, i < 10 ? 120 : -120); await page.waitForTimeout(100); }
  });
  await measure('tab switches (home>lend>pool>home)', page, cdp, async () => {
    for (const t of ['Lend', 'Pool', 'Home']) {
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: t }).click();
      await page.waitForTimeout(500);
    }
  });
  await measure('account sheet open + close', page, cdp, async () => {
    await page.locator('.wallet-pill').click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
  await measure('open Borrow screen', page, cdp, async () => {
    await page.getByRole('button', { name: 'Borrow', exact: true }).click();
    await page.locator('#amt').waitFor();
    await page.waitForTimeout(500);
  });
  await measure('stamp taps (tear 4)', page, cdp, async () => {
    const stamps = page.locator('.sgrid button:not(:disabled)');
    for (const i of [1, 3, 0, 5]) { await stamps.nth(i).click({ force: true }); await page.waitForTimeout(250); }
  });
  await measure('amount typing', page, cdp, async () => {
    await page.locator('#amt').click();
    await page.locator('#amt').fill('');
    await page.locator('#amt').pressSequentially('3.5', { delay: 60 });
  });
  // the knob (deposit + borrow are one slide now; a half drag springs back, nothing is sent)
  await page.locator('#amt').fill('2');
  const knob = page.getByRole('button', { name: /^Borrow .* USDC$/ });
  await knob.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await measure('slide knob (drag half, release)', page, cdp, async () => {
    const b = (await knob.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(b.x + b.width / 2 + i * 4, b.y + b.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(600);
  });

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const file = path.join(process.cwd(), 'e2e', 'test-results', `perf-${process.env.PERF_TAG || 'run'}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  await s.close();
});
