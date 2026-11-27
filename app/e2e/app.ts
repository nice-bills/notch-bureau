// Page helpers: open a browser session with the test wallet installed, click through the wallet picker, read text.
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { APP_URL, RPC_URL, WALLET_NAME, screensDir } from './env.ts';
import { fund, USDC_UNIT, tokenBalance } from './chain.ts';
import { installWallet, newWallet, type TestWallet } from './wallet.ts';
import { trackWallet } from './state.ts';

export interface Session {
  context: BrowserContext;
  page: Page;
  wallet: TestWallet;
  /** Uncaught errors thrown inside the page (a real bug if any). */
  pageErrors: string[];
  close: () => Promise<void>;
}

// One shared queue for every browser's RPC calls, ~5 per second, so the public devnet endpoint does not answer 429.
let rpcGate: Promise<void> = Promise.resolve();
const rpcTurn = () => {
  const turn = rpcGate.then(() => new Promise<void>((r) => setTimeout(r, 200)));
  rpcGate = turn;
  return turn;
};

export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

export const log = (msg: string) => console.log(`    ${msg}`);

/** Create a fresh wallet funded with SOL + test USDC and remember it so the teardown can sweep it. */
export async function fundedWallet(sol: bigint, usdc: bigint): Promise<TestWallet> {
  const w = await newWallet();
  trackWallet(w.secretKey);
  await fund(w, sol, usdc);
  return w;
}

export async function openSession(browser: Browser, wallet: TestWallet, opts: { phone?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext(opts.phone ? { ...PHONE } : { viewport: { width: 1280, height: 900 } });
  await installWallet(context, wallet);
  // The public devnet RPC rate-limits browsers too. Forward each call to the real RPC and retry on 429/5xx.
  await context.route(`${new URL(RPC_URL).origin}/**`, async (route) => {
    try {
      for (let i = 0; i < 20; i++) {
        await rpcTurn();
        const res = await route.fetch();
        if ((res.status() === 429 || res.status() >= 500) && i < 19) { await new Promise((r) => setTimeout(r, Math.min(700 * (i + 1), 4000))); continue; }
        return await route.fulfill({ response: res });
      }
    } catch { /* the page or context was closed while the request was in flight */ }
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  return { context, page, wallet, pageErrors, close: async () => { await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await context.close(); } };
}

export async function openTab(page: Page, tab: 'home' | 'lend' | 'pool') {
  const label = { home: 'Home', lend: 'Lend', pool: 'Pool' }[tab];
  const link = page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: label, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}

/** Open the sign-in sheet, check the test wallet is listed like Phantom would be, pick it, wait until connected. */
export async function connectWallet(page: Page, wallet: TestWallet) {
  const open = page.getByRole('button', { name: /^(Connect wallet|I already use Notch)$/ }).first();
  await open.click();
  const sheet = page.getByRole('dialog', { name: 'Sign in to start' });
  await expect(sheet).toBeVisible();
  const item = sheet.getByRole('menuitem', { name: new RegExp(WALLET_NAME) });
  await expect(item).toBeVisible();
  await expect(item.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await item.click();
  await expect(sheet).toBeHidden();
  const pill = page.locator('.wallet-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAccessibleName(`Your wallet ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`);
}

/** The stat tile with this label, inside `scope`. */
export function stat(scope: Page | Locator, label: string) {
  return scope.locator(`.stat:has(dt:text-is(${JSON.stringify(label)}))`);
}

/** Drag the slide-to-borrow knob all the way, like a finger would. */
export async function slide(page: Page, knob: Locator) {
  await expect(knob).toBeEnabled();
  const k = (await knob.boundingBox())!;
  const track = (await knob.locator('xpath=..').boundingBox())!;
  const y = k.y + k.height / 2;
  await page.mouse.move(k.x + k.width / 2, y);
  await page.mouse.down();
  const end = track.x + track.width - k.width / 2;
  for (let i = 1; i <= 12; i++) await page.mouse.move(k.x + k.width / 2 + ((end - k.x - k.width / 2) * i) / 12, y);
  await page.mouse.up();
}

/** Plain independent money formatting: micro-USDC -> "1,234.50" (cut to 2 decimals, like the app). */
export function usd2(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = ((micro % 1_000_000n).toString().padStart(6, '0')).slice(0, 2);
  return `${whole.toLocaleString('en-US')}.${frac}`;
}
/** Like the app's share counts: cut to 4 decimals, at least 2 ("4.9920", "10.00"). */
export function usd4(micro: bigint): string {
  let frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').slice(0, 4);
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${(micro / 1_000_000n).toLocaleString('en-US')}.${frac}`;
}
/** micro-USDC with up to 6 decimals, at least 2 ("0.80", "4.08", "4.987654"). */
export function usdFull(micro: bigint): string {
  const whole = micro / 1_000_000n;
  let frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

/** The value an input holds for an amount: no thousands separators, no trailing zeros ("0.8", "4"). */
/** usd2, rounded to the nearest cent (what the app shows for money you hold: 9.999999 reads 10.00). */
export function usd2r(micro: bigint): string {
  return usd2(((micro + 5_000n) / 10_000n) * 10_000n);
}

export function plain(micro: bigint): string {
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${micro / 1_000_000n}.${frac}` : `${micro / 1_000_000n}`;
}

export async function screenshot(page: Page, prefix: string, n: number, name: string) {
  fs.mkdirSync(screensDir, { recursive: true });
  const file = path.join(screensDir, `${prefix}-${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export { USDC_UNIT, tokenBalance };
