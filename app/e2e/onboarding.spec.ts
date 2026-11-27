// First-run onboarding (Onboarding.tsx): promise -> goal -> how money comes in -> two honest belief screens -> wallet
// asked only when the inbox needs it -> inbox -> waiting -> the limit said for their goal -> Borrow prefilled -> first
// loan. One question per screen, answers kept across Back and reload, a returning user skips it all.
// Takes a 360px-wide screenshot of every screen into e2e/screens/onboarding-*.png.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { readLine, waitFor } from './chain.ts';
import { fundedWallet, log, openSession, slide, usd2 } from './app.ts';
import { WALLET_NAME, screensDir } from './env.ts';

const SOL = (n: number) => BigInt(Math.round(n * 1e9));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const NARROW = { width: 360, height: 740 };

async function shot(page: Page, n: number, name: string) {
  fs.mkdirSync(screensDir, { recursive: true });
  await page.waitForTimeout(400); // let the step settle (progress bar, stamp drop)
  await page.screenshot({ path: path.join(screensDir, `onboarding-${String(n).padStart(2, '0')}-${name}.png`) });
}
async function rules(page: Page) {
  // the user's hard rules: no text field (so no blinking cursor), no native range slider, no sideways scroll,
  // no visible elapsed timer, no pencil / "Edit" chip
  await expect(page.locator('input[type=range]')).toHaveCount(0);
  await expect(page.getByText(/^\d+:\d\d$/)).toHaveCount(0);
  await expect(page.getByText(/✏|✎|^Edit$/)).toHaveCount(0);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, 'page scrolls sideways').toBeLessThanOrEqual(cw);
}

test.describe('First-run onboarding', () => {
  test('13. Onboarding: one question per screen, answers kept, wallet late, limit said for the goal, first loan from Borrow', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), USDC(1000));
    const s = await openSession(browser, w, { phone: true });
    const { page } = s;
    await page.setViewportSize(NARROW);
    try {
      await page.goto('/');

      log('1. the promise: no sign-in wall, one main button');
      await expect(page.getByText(/MoMo/)).toHaveCount(0); // the outcome is the headline; MoMo is named on the input step
      await expect(page.getByRole('heading', { name: 'Credit from the money history you already have.' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
      await rules(page);
      await shot(page, 1, 'promise');
      await page.getByRole('button', { name: 'Get started' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0); // still no wallet

      log('2. the goal: four answers, a tap moves on');
      await expect(page.getByRole('heading', { name: 'What’s the money for?' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '2');
      await expect(page.getByRole('radio')).toHaveCount(4);
      await rules(page);
      await shot(page, 2, 'goal');
      await page.getByRole('radio', { name: /Stock for my shop/ }).click();

      log('3. how money comes in');
      await expect(page.getByRole('heading', { name: 'How does your money come in?' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '3');

      log('Back keeps the answer; the browser Back works too; a reload keeps the place');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByRole('radio', { name: /Stock for my shop/ })).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('radio', { name: /Stock for my shop/ }).click();
      await expect(page.getByRole('heading', { name: 'How does your money come in?' })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'What’s the money for?' })).toBeVisible();
      await page.goForward();
      await expect(page.getByRole('heading', { name: 'How does your money come in?' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'How does your money come in?' })).toBeVisible();
      await rules(page);
      await shot(page, 3, 'paid');
      await page.getByRole('radio', { name: /Mobile money/ }).click();

      log('4. belief: private, said for their goal (true facts only)');
      await expect(page.getByRole('heading', { name: 'Your statement stays private.' })).toBeVisible();
      await expect(page.getByText('For your shop stock')).toBeVisible();
      await expect(page.getByText('Read inside sealed hardware')).toBeVisible();
      await rules(page);
      await shot(page, 4, 'private');
      await page.getByRole('button', { name: 'Next' }).click();

      log('5. belief: the cost up front, worked out by the same maths as Borrow');
      await expect(page.getByRole('heading', { name: 'The cost, up front.' })).toBeVisible();
      const eg = page.getByTestId('cost-example');
      await expect(eg).toContainText('You put down, 20%');
      await expect(eg).toContainText('You pay back51');
      await rules(page);
      await shot(page, 5, 'costs');
      await page.getByRole('button', { name: 'Next' }).click();

      log('6. the wallet, primed: what will pop up and why, then the real sheet');
      await expect(page.getByRole('heading', { name: 'Next: your private inbox.' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await rules(page);
      await shot(page, 6, 'wallet');
      await page.getByRole('button', { name: 'Connect wallet' }).click();
      const sheet = page.getByRole('dialog', { name: 'Sign in to start' });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('menuitem', { name: new RegExp(WALLET_NAME) }).click();
      await expect(sheet).toBeHidden();

      log('7. straight on to the inbox: the reason the wallet was asked for');
      await expect(page.getByRole('heading', { name: 'Your own inbox' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '7');
      await expect(page.getByTestId('works-today')).toHaveText('Works with MTN MoMo today. Bank statements are next.');
      await expect(page.getByRole('heading', { name: 'Upload a payout email' })).toHaveCount(0); // one path on the first run
      await rules(page);
      await shot(page, 7, 'inbox');
      await page.getByRole('button', { name: 'Get my inbox address' }).click();
      await expect(page.getByTestId('inbox-address')).toBeVisible({ timeout: 60_000 });

      log('8. the build moment: waiting, no timer, no spinning ring');
      await expect(page.getByRole('heading', { name: 'Waiting for your statement' })).toBeVisible();
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '8');
      await rules(page);
      await shot(page, 8, 'waiting');
      await page.getByRole('button', { name: 'Send a sample statement (demo)' }).click();

      log('9. the reveal: their goal, their number, one button');
      const amount = page.getByTestId('reveal-amount');
      await expect(amount).toBeVisible({ timeout: 90_000 });
      const limitText = (await amount.innerText()).trim();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`For your shop stock, you can draw up to ${limitText} USDC`);
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '9');
      await rules(page);
      await shot(page, 9, 'reveal');
      await page.getByRole('button', { name: 'Choose an amount' }).click();

      log('10. the first win: Borrow, prefilled with the whole limit, said for the goal');
      await expect(page.getByTestId('for-goal')).toHaveText('For your shop stock');
      await expect(page.getByRole('progressbar', { name: 'Getting started' })).toHaveAttribute('aria-valuenow', '10');
      // the whole limit (or what the pool has free, if less): the same number as "Up to …"
      const upTo = (await page.locator('label[for=amt] span').innerText()).replace(/^Up to /, '').replace(/,/g, '');
      await expect(page.locator('#amt')).toHaveValue(upTo.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'));
      await expect(page.locator('input[type=range]')).toHaveCount(0);
      await shot(page, 10, 'borrow');
      await slide(page, page.getByRole('button', { name: /^Borrow .* USDC$/ }));
      await expect(page.getByRole('dialog', { name: 'Sent' })).toBeVisible({ timeout: 60_000 });
      const line = await waitFor('line drawn', () => readLine(w.address), (l) => !!l && l.drawn > 0n);
      expect(usd2(line!.limit)).toBe(limitText);
      await shot(page, 11, 'sent');
      await page.getByRole('dialog', { name: 'Sent' }).getByRole('button', { name: 'Done' }).click();

      log('never an empty home: the loan is there, and it can be paid back (keeps the shared devnet pool clean)');
      await expect(page.getByTestId('available')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Pay back' }).click();
      await page.getByRole('button', { name: /^Repay .* USDC$/ }).click();
      await expect(page.getByRole('dialog', { name: 'Paid back' })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('dialog', { name: 'Paid back' }).getByRole('button', { name: 'Done' }).click();

      log('a returning user skips the questions');
      await page.reload();
      await expect(page.getByTestId('available')).toBeVisible({ timeout: 30_000 });
      await page.locator('.wallet-pill').click();
      await page.getByRole('button', { name: 'Disconnect wallet' }).click();
      await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
      await expect(page.getByText('Connect your wallet to see your limit for your shop stock.')).toBeVisible();
      await shot(page, 12, 'welcome-back');
      expect(await page.locator('.onb[data-step]').count()).toBe(0);
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow13-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('14. Onboarding, paid into a bank: told plainly that MoMo is what works today, before the wallet is asked', async ({ browser }) => {
    const context = await browser.newContext({ viewport: NARROW, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Get started' }).click();
      await page.getByRole('radio', { name: /School fees/ }).click();
      await page.getByRole('radio', { name: /A bank account/ }).click();
      await expect(page.getByText('For school fees')).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByTestId('bank-honest')).toContainText('Today Notch reads MTN MoMo statements only.');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await rules(page);
      await shot(page, 13, 'wallet-bank');
    } finally {
      await context.close();
    }
  });
});
