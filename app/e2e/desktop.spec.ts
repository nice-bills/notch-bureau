// Wide screens (desktop.css, desk.tsx): the landing is a two-sided hero with a QR code for the phone; every other screen
// is one framed column under a slim top bar, with no floating tab bar. The phone layout must not change.
// Takes screenshots into e2e/screens/desktop-*.png at 1280x800, 1440x900, 1920x1080 and a 390x844 phone.
// Needs no money: an empty throwaway wallet is enough to see every screen.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { connectWallet, log, openSession } from './app.ts';
import { screensDir } from './env.ts';
import { newWallet } from './wallet.ts';

async function shot(page: Page, name: string) {
  fs.mkdirSync(screensDir, { recursive: true });
  await page.waitForTimeout(500);
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
    new Promise((r) => setTimeout(r, 4000)),
  ]));
  await page.screenshot({ path: path.join(screensDir, `desktop-${name}.png`) });
}

/** The user's rules, on every screen: no slider, no timer, no pencil or Edit chip, no sideways scroll. */
async function rules(page: Page) {
  await expect(page.locator('input[type=range]')).toHaveCount(0);
  await expect(page.getByText(/^\d+:\d\d$/)).toHaveCount(0);
  await expect(page.getByText(/✏|✎|^Edit$/)).toHaveCount(0);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, 'page scrolls sideways').toBeLessThanOrEqual(cw);
}

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

test.describe('Wide screens', () => {
  for (const size of SIZES) {
    test(`Desktop ${size.width}x${size.height}: hero landing, framed column, top bar`, async ({ browser }) => {
      const s = await openSession(browser, await newWallet());
      const { page } = s;
      await page.setViewportSize(size);
      const tag = String(size.width);
      try {
        await page.goto('/');
        log('landing: words on the left, envelope on the right, a QR for the phone');
        const h1 = page.getByRole('heading', { name: 'Credit from the money history you already have.' });
        await expect(h1).toBeVisible();
        await expect(page.locator('.deskbar')).toBeHidden(); // the hero has its own brand
        await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
        const qr = page.getByRole('complementary', { name: 'Open Notch on your phone' });
        await expect(qr.locator('svg[role=img]')).toHaveAttribute('aria-label', /^QR code for http/);
        const [hb, eb, gb] = await Promise.all([h1.boundingBox(), page.locator('.welcome-live .hero').boundingBox(), page.getByRole('button', { name: 'Get started' }).boundingBox()]);
        expect(hb!.x + hb!.width, 'headline stays left of the envelope').toBeLessThan(eb!.x);
        expect(gb!.y + gb!.height, '"Get started" is on the first screen').toBeLessThanOrEqual(size.height);
        await expect(page.getByRole('button', { name: 'I already use Notch' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'I want to lend' })).toBeVisible();
        await rules(page);
        await shot(page, `${tag}-01-landing`);

        log('the stamp wall still plays: a click flies a stamp onto the envelope and the example limit grows');
        const picks = await page.evaluate(() => {
          const hero = document.querySelector('.welcome-live .hero')!.getBoundingClientRect();
          const qrBox = document.querySelector('.desk-qr')!.getBoundingClientRect();
          const inside = (r: DOMRect, x: number, y: number) => x > r.left - 20 && x < r.right + 20 && y > r.top - 20 && y < r.bottom + 60;
          return [...document.querySelectorAll('.wall .st')].map((el) => el.getBoundingClientRect())
            .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
            .filter(({ x, y }) => x > innerWidth * 0.62 && x < innerWidth - 40 && y > 60 && y < innerHeight - 60 && !inside(hero, x, y) && !inside(qrBox, x, y))
            .slice(0, 3);
        });
        expect(picks.length).toBe(3);
        for (const p of picks) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(650); }
        await expect(page.locator('.welcome-live .hero')).toHaveAccessibleName(/^Example limit [1-9]\d* USDC/);
        await expect(page.locator('.hero-hint')).toContainText('3 payments');
        if (size.width === 1440) await shot(page, `${tag}-02-stamped`);

        log('a question step: centred column, brand bar without sections');
        await page.getByRole('button', { name: 'Get started' }).click();
        await expect(page.locator('.onb[data-step="1"]')).toBeVisible();
        await expect(page.locator('.deskbar')).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
        await rules(page);
        await shot(page, `${tag}-03-question`);

        log('signed in: top bar with sections and the wallet; no floating tab bar');
        await page.evaluate(() => localStorage.removeItem('notch.onboard.v1'));
        await page.goto('/');
        await connectWallet(page, s.wallet);
        await expect(page.locator('.wallet-pill')).toHaveCount(1);
        await expect(page.locator('.deskbar .wallet-pill')).toBeVisible();
        await expect(page.locator('nav.tabs')).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
        const col = await page.locator('.app').boundingBox();
        expect(col!.width, 'one centred column').toBeLessThanOrEqual(480);
        expect(Math.abs(col!.x + col!.width / 2 - size.width / 2)).toBeLessThan(2);
        await expect(page.getByText('Reading your line…')).toHaveCount(0, { timeout: 60_000 });
        await rules(page);
        await shot(page, `${tag}-04-home`);

        for (const [tab, label, n] of [['lend', 'Lend', '05'], ['pool', 'Pool', '06']] as const) {
          const link = page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: label, exact: true });
          await link.click();
          await expect(link).toHaveAttribute('aria-current', 'page');
          await rules(page);
          await shot(page, `${tag}-${n}-${tab}`);
        }

        await page.evaluate(() => { location.hash = '#limit'; });
        await expect(page.locator('.deskbar .wallet-pill')).toBeVisible();
        await rules(page);
        await shot(page, `${tag}-07-limit`);

        log('a sheet opens as a centred card');
        await page.locator('.deskbar .wallet-pill').click();
        const sheet = page.getByRole('dialog', { name: 'Your wallet' });
        await expect(sheet).toBeVisible();
        const sb = await sheet.boundingBox();
        expect(sb!.y, 'the sheet is not stuck to the bottom edge').toBeGreaterThan(size.height * 0.05);
        if (size.width === 1440) await shot(page, `${tag}-08-sheet`);
        expect(s.pageErrors).toEqual([]);
      } finally {
        await s.close();
      }
    });
  }

  test('Phone 390x844: unchanged (tab bar, no top bar, no QR)', async ({ browser }) => {
    const s = await openSession(browser, await newWallet(), { phone: true });
    const { page } = s;
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Credit from the money history you already have.' })).toBeVisible();
      await expect(page.locator('.deskbar')).toHaveCount(0);
      await expect(page.locator('.desk-qr')).toHaveCount(0);
      await expect(page.getByText('Tap the stamps. Each one is a payment in your money history.')).toBeVisible();
      await rules(page);
      await shot(page, 'phone-01-landing');
      await connectWallet(page, s.wallet);
      await expect(page.locator('.wallet-pill')).toHaveCount(1);
      await expect(page.locator('nav.tabs')).toBeVisible();
      await expect(page.locator('.deskbar')).toHaveCount(0);
      const col = await page.locator('.app').boundingBox();
      expect(col!.width).toBe(390);
      await rules(page);
      await shot(page, 'phone-02-home');
      expect(s.pageErrors).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
