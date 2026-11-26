// Phone-test fixes, end to end (Nov 26 phone review): one wallet session for the whole app, no blank tab switches,
// plain words when a fresh wallet has no SOL, the signed limit kept after Back and reload, and phone wallets
// (Phantom deeplinks on iPhone through a fake Phantom app; Mobile Wallet Adapter listed on Android).
import { expect, test, type Page, type Route } from '@playwright/test';
import nacl from 'tweetnacl';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { readLine, waitFor } from './chain.ts';
import { PHONE, connectWallet, fundedWallet, log, openSession, openTab, usd2 } from './app.ts';
import { APP_URL, RPC_URL } from './env.ts';
import { newWallet, signWire, type TestWallet } from './wallet.ts';
import { trackWallet } from './state.ts';

const SOL = (n: number) => BigInt(Math.round(n * 1e9));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const b58 = (u: Uint8Array) => getBase58Decoder().decode(u);
const unb58 = (s: string) => new Uint8Array(getBase58Encoder().encode(s));
const toast = (page: Page, text: string | RegExp) => page.locator('.action-status.good, .done-view').filter({ hasText: text });

/** Records whether the main area was ever empty (no screen, or a screen with no text) while tabs switch. */
async function watchForBlank(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __blank: number; __blankObs?: MutationObserver };
    w.__blank = 0;
    const check = () => {
      const s = document.querySelector('#main .screen-in');
      if (!s || !(s.textContent ?? '').trim()) w.__blank++;
    };
    w.__blankObs = new MutationObserver(check);
    w.__blankObs.observe(document.getElementById('main')!, { childList: true, subtree: true });
  });
}
const blanks = (page: Page) => page.evaluate(() => (window as unknown as { __blank: number }).__blank);

/** Get a signed limit through the inbox and the demo mailer. Returns the limit shown. */
async function getSignedLimit(page: Page) {
  await page.getByRole('button', { name: 'Get my limit' }).click();
  await page.getByRole('button', { name: 'Get my inbox address' }).click();
  await expect(page.getByTestId('inbox-address')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Send a sample statement (demo)' }).click();
  await expect(page.getByRole('button', { name: 'Post my limit' })).toBeVisible({ timeout: 90_000 });
  return (await page.locator('.ticket-num').innerText()).trim();
}

test.describe('Phone review fixes', () => {
  test('7. One session: connect once, stay connected across tabs and a reload; tabs never flash blank; no tab bar on the welcome', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.01), 0n);
    const s = await openSession(browser, w, { phone: true });
    const { page } = s;
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Borrow against your income, without showing it.' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0); // the tab bar covered "Get started"
      await connectWallet(page, w);
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

      await watchForBlank(page);
      const signs0 = w.signCount;
      for (const tab of ['lend', 'pool', 'home', 'pool', 'lend'] as const) {
        await openTab(page, tab);
        await expect(page.locator('.wallet-pill')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);
        await expect(page.getByRole('dialog', { name: 'Sign in to start' })).toHaveCount(0);
      }
      expect(await blanks(page), 'the screen went blank during a tab switch').toBe(0);
      expect(w.signCount).toBe(signs0);

      log('reload: the wallet reconnects silently, on the same tab');
      await page.reload();
      await expect(page.locator('.wallet-pill')).toHaveAccessibleName(`Your wallet ${w.address.slice(0, 4)}…${w.address.slice(-4)}`);
      await expect(page.getByRole('heading', { name: 'Lend', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);
      await openTab(page, 'home');
      await expect(page.getByRole('button', { name: 'Get started' })).toHaveCount(0);
      await expect(page.locator('.wallet-pill')).toBeVisible();

      log('disconnect forgets the session: a reload shows the welcome again');
      await page.locator('.wallet-pill').click();
      await page.getByRole('button', { name: 'Disconnect wallet' }).click();
      await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow7-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('8. Fresh wallet with no SOL: plain-words post error, limit kept after Back and reload, one-tap test money, then post', async ({ browser }) => {
    const w = await newWallet(); // nothing at all: like a brand-new Phantom devnet wallet
    trackWallet(w.secretKey);
    const s = await openSession(browser, w, { phone: true });
    const { page } = s;
    try {
      await page.goto('/');
      await connectWallet(page, w);
      await expect(page.getByText('Your wallet has no devnet SOL for network fees yet.')).toBeVisible();
      const limitText = await getSignedLimit(page);
      await expect(page.getByText('Posting needs a little devnet SOL')).toBeVisible();

      log('post with 0 SOL: refused before the wallet is asked, in plain words, with a faucet button');
      const signs0 = w.signCount;
      await page.getByRole('button', { name: 'Post my limit' }).click();
      const bad = page.locator('.action-status.bad');
      await expect(bad).toContainText('Your wallet has no devnet SOL to pay the network fee. Get free test SOL below, then try again.');
      await expect(bad).not.toContainText('Something went wrong');
      await expect(bad.getByRole('button', { name: 'Get test SOL and USDC' })).toBeVisible();
      expect(w.signCount).toBe(signs0);

      log('Back keeps the signed limit, and so does a reload');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Limit ready, post it' })).toBeVisible();
      await expect(page.getByTestId('ready-amount')).toHaveText(limitText);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Limit ready, post it' })).toBeVisible();
      await expect(page.getByTestId('ready-amount')).toHaveText(limitText);

      log('one tap of test money (devnet faucet on the demo server)');
      await page.getByRole('button', { name: 'Get test SOL and USDC' }).click();
      await expect(page.getByText('Sent 0.02 SOL and 100 test USDC to your wallet.')).toBeVisible({ timeout: 60_000 });

      await page.getByRole('button', { name: 'Limit ready, post it' }).click();
      await page.getByRole('button', { name: 'Post my limit' }).click();
      await expect(toast(page, 'Your limit is now on Solana.')).toBeVisible({ timeout: 60_000 });
      const line = await waitFor('line posted', () => readLine(w.address), (l) => l !== null);
      expect(usd2(line!.limit)).toBe(limitText);
      await page.getByRole('button', { name: 'Start borrowing' }).click();
      await expect(page.getByTestId('available')).toHaveText(`${limitText}USDC`);
      await expect(page.getByRole('button', { name: 'Limit ready, post it' })).toHaveCount(0);
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow8-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('9. iPhone browser: Phantom deeplinks (connect, sign message, sign transaction) through a fake Phantom app', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), 0n);
    const context = await browser.newContext({
      ...PHONE,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      baseURL: APP_URL,
    });
    // Same network path as the others; `drop` makes the next reads fail the way iOS Safari drops requests in flight
    // when the user switches apps ("Load failed").
    let drop = 0;
    await context.route(`${new URL(RPC_URL).origin}/**`, (r) => {
      if (drop > 0 && /getMultipleAccounts/.test(r.request().postData() ?? '')) { drop--; return r.abort('failed'); }
      return r.continue();
    });
    const phantom = fakePhantom(w);
    await context.route('https://phantom.app/ul/v1/**', (r) => phantom(r));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Get started' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sign in to start' });
      await expect(sheet.getByRole('menuitem', { name: /Phantom app/ })).toBeVisible();
      await expect(sheet.getByRole('link', { name: /Open in Phantom/ })).toHaveAttribute('href', /^https:\/\/phantom\.app\/ul\/browse\//);
      await expect(sheet.getByRole('link', { name: /Open in Solflare/ })).toBeVisible();

      log('a cancel in the Phantom app comes back as plain words, still signed out');
      phantom.reject = true;
      await sheet.getByRole('menuitem', { name: /Phantom app/ }).click();
      await expect(page.locator('.return-banner.bad')).toContainText('You cancelled in Phantom. Nothing was signed.', { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
      phantom.reject = false;

      log('connect: to the Phantom app and back');
      await page.getByRole('button', { name: 'Get started' }).click();
      await sheet.getByRole('menuitem', { name: /Phantom app/ }).click();
      await expect(page.locator('.wallet-pill')).toHaveAccessibleName(`Your wallet ${w.address.slice(0, 4)}…${w.address.slice(-4)}`, { timeout: 30_000 });
      expect(new URL(page.url()).searchParams.has('phantom')).toBe(false); // the answer is cleaned out of the URL

      log('inbox address: the message is signed in the Phantom app');
      await page.getByRole('button', { name: 'Get my limit' }).click();
      await page.getByRole('button', { name: 'Get my inbox address' }).click();
      await expect(page.getByTestId('inbox-address')).toHaveText(/^[a-z2-7]{10}@inbox\.notch\.invalid$/, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Send a sample statement (demo)' }).click();
      await expect(page.getByRole('button', { name: 'Post my limit' })).toBeVisible({ timeout: 90_000 });

      log('post: the transaction is signed in the Phantom app, sent on return; the screen catches up without a reload');
      drop = 2; // two reads fail right after the return: retried, no "Can't reach Solana" banner
      await page.getByRole('button', { name: 'Post my limit' }).click();
      await expect(page.locator('.return-banner.good')).toContainText('Done: your transaction is on Solana.', { timeout: 60_000 });
      const line = await waitFor('line posted', () => readLine(w.address), (l) => l !== null);
      expect(line!.limit).toBeGreaterThan(0n);
      await expect(page.getByText('Your limit is on Solana').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Can’t reach Solana right now')).toHaveCount(0);
      expect(drop, 'the dropped reads happened').toBe(0);
      await page.getByRole('button', { name: 'Start borrowing' }).click();
      await expect(page.getByTestId('available')).toBeVisible({ timeout: 30_000 });
      expect(phantom.calls).toEqual(['connect', 'connect', 'signMessage', 'signTransaction']);
      expect(errors).toEqual([]);
    } catch (e) {
      console.log('URL at failure:', page.url(), 'errors:', errors);
      await page.screenshot({ path: 'e2e/test-results/flow9-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await context.close();
    }
  });

  test('10. Android browser: Mobile Wallet Adapter is offered in the sign-in sheet', async ({ browser }) => {
    const context = await browser.newContext({
      ...PHONE,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
      baseURL: APP_URL,
    });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Get started' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sign in to start' });
      await expect(sheet.getByRole('menuitem', { name: /Wallet app on this phone/ })).toBeVisible({ timeout: 15_000 });
      await expect(sheet).toContainText('Phantom, Solflare or Seed Vault opens to approve');
      await expect(sheet.getByRole('link', { name: /Open in Phantom/ })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('11. iPhone Safari: WalletConnect is listed, its code loads only on tap, and a remembered session reconnects silently', async ({ browser }) => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    const context = await browser.newContext({ ...PHONE, userAgent: IPHONE, baseURL: APP_URL });
    // Nothing leaves for WalletConnect's servers (the e2e build uses a fake project id).
    await context.route(/walletconnect\.(com|org)|reown\.com|web3modal\.(com|org)/, (r) => r.abort());
    const wcCode: string[] = [];
    context.on('request', (r) => { if (/wc-session|@reown|universal-provider/.test(r.url())) wcCode.push(r.url()); });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Get started' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sign in to start' });
      const wc = sheet.getByRole('menuitem', { name: /Other wallet apps/ });
      await expect(wc).toBeVisible({ timeout: 15_000 });
      await expect(sheet).toContainText('Pick yours from a list');
      await expect(sheet.getByRole('menuitem', { name: /Phantom app/ })).toBeVisible(); // the Phantom deeplink stays
      expect(wcCode, 'no WalletConnect code before the tap').toEqual([]);
      const loaded = page.waitForRequest((r) => /wc-session/.test(r.url()), { timeout: 15_000 });
      await wc.click();
      await loaded;
      log(`WalletConnect code fetched on tap (${wcCode.length} requests)`);
      // only the tapped row spins; the others stay usable; closing the sheet clears it
      const phantomRow = sheet.getByRole('menuitem', { name: /Phantom app/ });
      await expect(wc).toHaveAttribute('aria-busy', 'true');
      await expect(phantomRow).not.toHaveAttribute('aria-busy', 'true');
      await expect(phantomRow).toBeEnabled();
      await expect(sheet.locator('.spinner')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await page.locator('w3m-modal').evaluate((m) => m.remove()).catch(() => {}); // AppKit's own overlay, if it opened
      await page.getByRole('button', { name: 'Get started' }).click();
      await expect(sheet.locator('.spinner')).toHaveCount(0);

      // A remembered WalletConnect session: the app reconnects on load without downloading the WalletConnect code.
      const me = '8vCHa2FTUp2Xf1Yb1pEhUUyRLrEJCGKdj77CB2uLzBE5';
      const page2 = await context.newPage();
      await page2.addInitScript((a) => { localStorage.setItem('notch.wallet', 'WalletConnect'); localStorage.setItem('notch.wc.address', a); }, me);
      wcCode.length = 0;
      await page2.goto('/');
      await expect(page2.getByText('Hello, 8vCH')).toBeVisible({ timeout: 15_000 });
      await expect(page2.getByRole('button', { name: /Your wallet 8vCH/ })).toBeVisible();
      expect(wcCode.filter((u) => /wc-session/.test(u)), 'silent reconnect needs no WalletConnect code').toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/**
 * A stand-in for the Phantom app's deeplink endpoints, implementing the documented protocol: X25519 box with the dapp's
 * key, a session token, base58 payloads, and a redirect back to `redirect_link` with `phantom_encryption_public_key`
 * (connect only), `nonce` and `data`. It signs with the test wallet's key.
 */
function fakePhantom(w: TestWallet) {
  const kp = nacl.box.keyPair();
  const calls: string[] = [];
  const state = { reject: false };
  const handler = async (route: Route) => {
    const u = new URL(route.request().url());
    const action = u.pathname.split('/').pop()!;
    calls.push(action);
    const back = new URL(u.searchParams.get('redirect_link')!);
    if (state.reject) {
      back.searchParams.set('errorCode', '4001');
      back.searchParams.set('errorMessage', 'User rejected the request.');
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    }
    const dappPub = unb58(u.searchParams.get('dapp_encryption_public_key')!);
    const shared = nacl.box.before(dappPub, kp.secretKey);
    const seal = (obj: unknown) => {
      const nonce = nacl.randomBytes(24);
      back.searchParams.set('nonce', b58(nonce));
      back.searchParams.set('data', b58(nacl.box.after(new TextEncoder().encode(JSON.stringify(obj)), nonce, shared)));
    };
    const open = () => JSON.parse(new TextDecoder().decode(nacl.box.open.after(unb58(u.searchParams.get('payload')!), unb58(u.searchParams.get('nonce')!), shared)!)) as Record<string, string>;
    if (action === 'connect') {
      back.searchParams.set('phantom_encryption_public_key', b58(kp.publicKey));
      seal({ public_key: w.address, session: 'fake-session' });
    } else if (action === 'signMessage') {
      const req = open();
      if (req.session !== 'fake-session') throw new Error('bad session');
      seal({ signature: b58(nacl.sign.detached(unb58(req.message), w.secretKey)) });
    } else if (action === 'signTransaction') {
      const req = open();
      if (req.session !== 'fake-session') throw new Error('bad session');
      w.signCount++;
      seal({ transaction: b58(signWire(w, unb58(req.transaction))) });
    }
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  };
  return Object.defineProperty(Object.assign(handler, { calls }), 'reject', { set(v: boolean) { state.reject = v; }, get() { return state.reject; } }) as typeof handler & { calls: string[]; reject: boolean };
}
