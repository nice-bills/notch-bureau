// Browser end-to-end tests. Everything is real: Chromium, the Vite app, a Wallet Standard test wallet that signs
// in Node, the demo underwriter on :8787 (its statement inbox, and a real DKIM check on freshly signed synthetic emails)
// and the Notch program on the chain. Each flow clicks through the UI, asserts the visible text, then reads the
// accounts back from the chain. Only synthetic statements are used.
import { expect, test, type Page } from '@playwright/test';
import nacl from 'tweetnacl';
import { address, getAddressEncoder } from '@solana/kit';
import {
  CLAIM_WINDOW_SECONDS,
  WITHDRAW_COOLDOWN_SECONDS,
  base64ToBytes,
  decodeRecord,
  depositNeededFor,
  feeFor,
  payoffFor,
  sharesForDeposit,
} from '../src/notch.ts';
import { ERROR_MESSAGES } from '../src/errors.ts';
import { escrowShares, readLine, readPool, readUnderwriter, readWithdrawRequest, shareBalance, tokenBalance, waitFor } from './chain.ts';
import { loadState, saveState } from './state.ts';
import { PHONE, connectWallet, fundedWallet, log, openSession, openTab, screenshot, slide, stat, plain, usd2, usd2r, usdFull, type Session } from './app.ts';

const SOL = (n: number) => BigInt(Math.round(n * 1e9));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Strings from the synthetic MoMo statement that must never reach the page: income, balance, names, the sender's number. */
const SECRETS_IN_MOMO_EMAIL = ['1,250', '1250', '1,300', '1300', 'GHS', 'KWAME', 'ASANTE', 'KOFI', 'MENSAH', '024 000', 'MP261122', 'design work'];
const REPLY_KEYS = ['expiry', 'extraction', 'limitUsdc', 'message', 'nonce', 'ok', 'signature'];

const toast = (page: Page, text: string | RegExp) => page.locator('.action-status.good, .done-view').filter({ hasText: text });
const failure = (page: Page, text: string | RegExp) => page.locator('.action-status.bad').filter({ hasText: text });
const back = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();

// ============================================================================================================
// Flow 1 (and flow 6): borrow end to end. `shots` adds a screenshot per step.
// ============================================================================================================
async function borrowFlow(s: Session, o: { shots?: string; extras?: boolean }) {
  const { page, wallet: w } = s;
  let n = 0;
  const shot = async (name: string) => { if (o.shots) { await page.waitForTimeout(500); await screenshot(page, o.shots, ++n, name); } };
  const noOverflow = async () => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw, 'page scrolls sideways').toBeLessThanOrEqual(cw);
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Borrow against your income, without showing it.' })).toBeVisible();
  if (!o.shots) {
    // desktop: a centred phone-width column, not stretched
    const col = await page.locator('.app').boundingBox();
    expect(col!.width).toBeLessThanOrEqual(440);
    expect(Math.abs(col!.x + col!.width / 2 - 640)).toBeLessThan(4);
  }
  await shot('welcome');

  // --- connect ---------------------------------------------------------------------------------------
  log('connect through the sign-in sheet');
  await connectWallet(page, w);
  await expect(page.getByText('No limit yet')).toBeVisible();
  await expect(page.getByTestId('wallet-usdc')).toHaveText(usd2(await tokenBalance(w.address)));
  await shot('connected');
  if (o.shots) await noOverflow();

  // --- the statement inbox ----------------------------------------------------------------------------
  log('get an inbox address (wallet signs a message), then the demo mailer delivers a synthetic MoMo statement');
  await page.getByRole('button', { name: 'Get my limit' }).click();
  await expect(page.getByRole('heading', { name: 'Your own inbox' })).toBeVisible();
  const msgs0 = w.messageCount ?? 0;
  await page.getByRole('button', { name: 'Get my inbox address' }).click();
  const addr = page.getByTestId('inbox-address');
  await expect(addr).toHaveText(/^[a-z2-7]{10}@inbox\.notch\.invalid$/);
  expect(w.messageCount, 'the wallet signed the inbox request').toBe(msgs0 + 1);
  await expect(page.getByRole('heading', { name: 'Waiting for your statement' })).toBeVisible();
  await expect(page.getByLabel('Statement status')).toContainText('Waiting for the email');
  await shot('inbox');
  if (o.shots) await noOverflow();

  const ready = page.waitForResponse(async (r) => r.url().includes(`/record/${w.address}`) && r.ok() && (await r.json()).status === 'ready', { timeout: 120_000 });
  const delivered = page.waitForResponse((r) => r.url().endsWith('/demo/deliver'));
  await page.getByRole('button', { name: 'Send a sample statement (demo)' }).click();
  expect((await delivered).status()).toBe(200);
  const replyJson = (await (await ready).json()) as Record<string, unknown>;
  const ticket = page.getByRole('figure', { name: 'What left the sealed computer' });
  await expect(ticket).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Your limit came back' })).toBeVisible();
  await shot('what-left');
  if (o.shots) await noOverflow();

  // What left the sealed computer: only a limit and a signature.
  expect(Object.keys(replyJson).filter((k) => k !== 'status').sort()).toEqual(REPLY_KEYS);
  const record = decodeRecord(base64ToBytes(replyJson.message as string));
  const limit = record.limitMicro;
  expect(limit).toBeGreaterThan(0n);
  await expect(ticket).toContainText('USDC credit limit');
  await expect(ticket.locator('.ticket-num')).toHaveText(usd2(limit));
  await expect(ticket.locator('.ticket-facts dt')).toHaveText(['Made for wallet', 'Good until', 'Email fingerprint', 'Counter']);
  await expect(ticket).toContainText('Stayed inside');
  const rawRecord = base64ToBytes(replyJson.message as string);
  expect(Buffer.from(rawRecord.subarray(8, 40)).equals(Buffer.from(getAddressEncoder().encode(address(w.address))))).toBe(true);
  const uwKey = new Uint8Array(getAddressEncoder().encode(address(await readUnderwriter())));
  expect(nacl.sign.detached.verify(rawRecord, base64ToBytes(replyJson.signature as string), uwKey)).toBe(true);

  await page.locator('details.raw summary').click();
  const rawText = await page.locator('details.raw pre').innerText();
  expect(Object.keys(JSON.parse(rawText)).sort()).toEqual(REPLY_KEYS);
  // No income amount, balance, name or phone number anywhere: rendered text, hidden text, the whole HTML, the raw reply, the network reply.
  const pageText = await page.evaluate(() => document.body.innerText);
  const pageHtml = await page.content();
  const pageContent = await page.evaluate(() => document.body.textContent ?? '');
  const networkText = JSON.stringify(replyJson);
  const noB64 = (t: string) => t.split(String(replyJson.message)).join('').split(String(replyJson.signature)).join('');
  for (const secret of SECRETS_IN_MOMO_EMAIL) {
    for (const [where, hay] of [['visible text', pageText], ['page text', pageContent], ['page HTML', pageHtml], ['raw reply', rawText], ['network reply', networkText]] as const) {
      expect(noB64(hay).toLowerCase().includes(secret.toLowerCase()), `"${secret}" leaked into the ${where}`).toBe(false);
    }
  }
  expect(await readLine(w.address)).toBeNull(); // nothing posted yet

  // --- post the limit: the stamp lands ---------------------------------------------------------------
  log('post the limit');
  await page.getByRole('button', { name: 'Post my limit' }).click();
  await expect(page.getByRole('heading', { name: /USDC to borrow/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('landed-amount')).toHaveText(usd2(limit));
  await expect(toast(page, 'Your limit is now on Solana.')).toBeVisible();
  let line = await waitFor('credit line exists', () => readLine(w.address), (l) => l !== null);
  expect(line!.wallet).toBe(w.address);
  expect(line!.limit).toBe(limit);
  expect(line!.expiry).toBe(record.expiry);
  expect(line!.lastNonce).toBe(record.nonce);
  expect(line!.drawn).toBe(0n);
  expect(line!.deposit).toBe(0n);
  expect(line!.defaulted).toBe(false);
  await shot('limit-landed');
  await page.getByRole('button', { name: 'Start borrowing' }).click();
  await expect(page.getByTestId('available')).toHaveText(`${usd2(limit)}USDC`);
  await expect(page.getByTestId('limit')).toHaveText(`${usd2(limit)} limit`);
  await shot('home-limit');

  // --- choose an amount, deposit 20% ----------------------------------------------------------------------
  const draw = limit >= USDC(4) ? USDC(4) : (limit / 2n / 10_000n) * 10_000n;
  const needed = depositNeededFor(draw);
  const fee = feeFor(draw);
  const payoff = payoffFor(draw);
  const walletUsdc0 = await tokenBalance(w.address);
  const pool0 = await readPool();

  log(`deposit 20% (${usdFull(needed)}) for a ${usdFull(draw)} draw`);
  await page.getByRole('button', { name: 'Borrow', exact: true }).click();
  await page.locator('#amt').fill(plain(draw));
  await expect(page.getByTestId('dep-needed')).toHaveText(usdFull(needed));
  await expect(page.getByTestId('dep-add')).toHaveText(usdFull(needed));
  await expect(page.getByText(`Pay back ${usdFull(payoff)} by`)).toBeVisible();
  await shot('amount-chosen');
  if (o.shots) await noOverflow();
  await page.getByRole('button', { name: `Add ${usdFull(needed)} USDC deposit` }).click();
  await expect(toast(page, `Deposit added: ${usdFull(needed)} USDC.`)).toBeVisible();
  line = await waitFor('deposit lands', () => readLine(w.address), (l) => l?.deposit === needed);
  expect(line!.drawn).toBe(0n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - needed);
  expect((await readPool()).stats.borrowerDeposits).toBe(pool0.stats.borrowerDeposits + needed);
  await expect(page.getByTestId('dep-add')).toHaveText('0.00');
  await shot('deposit-added');

  // --- draw: slide to borrow ------------------------------------------------------------------------------
  log(`slide to borrow ${usdFull(draw)}`);
  await slide(page, page.getByRole('button', { name: `Borrow ${usdFull(draw)} USDC` }));
  const sent = page.getByRole('dialog', { name: 'Sent' });
  await expect(sent).toBeVisible({ timeout: 60_000 });
  await expect(sent).toContainText(`${usd2(draw)} USDC`);
  await expect(sent).toContainText('is in your wallet');
  await expect(sent.getByRole('link', { name: 'View on Solana Explorer' })).toBeVisible();
  line = await waitFor('draw lands', () => readLine(w.address), (l) => l?.drawn === draw);
  expect(line!.deposit).toBe(needed);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  expect(line!.due).toBeGreaterThan(nowS + 29n * 86_400n);
  expect(line!.due).toBeLessThan(nowS + 31n * 86_400n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - needed + draw);
  const pool1 = await readPool();
  expect(pool1.stats.outstanding - pool0.stats.outstanding).toBe(draw);
  expect(pool1.stats.totalLent - pool0.stats.totalLent).toBe(draw);
  await shot('drawn');
  await sent.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('limit')).toBeVisible();
  await expect(page.locator('.line-card .tag')).toContainText('DUE');
  await expect(page.getByText(`Pay ${usdFull(payoff)} USDC`)).toBeVisible();
  await expect(page.getByTestId('deposit')).toHaveText(usd2(needed));
  await shot('home-owing');
  if (o.shots) await noOverflow();

  // --- (flow 5, part 1) the mark-default control for a loan that is out but not overdue -------------------------
  if (o.extras) { await markDefaultNotOverdue(s, line!.due); await openTab(page, 'home'); }

  // --- repay principal + 2% ---------------------------------------------------------------------------------
  log(`repay ${usdFull(payoff)}`);
  const balBeforeRepay = await tokenBalance(w.address);
  await page.getByRole('button', { name: 'Pay back' }).click();
  const repay = page.getByRole('dialog', { name: 'Pay back' });
  await expect(repay).toContainText(`You pay${usdFull(payoff)}`);
  await expect(repay).toContainText(`Deposit back+${usdFull(needed)}`);
  await shot('repay-sheet');
  await repay.getByRole('button', { name: `Repay ${usdFull(payoff)} USDC` }).click();
  await expect(page.getByRole('dialog', { name: 'Paid back' })).toContainText(`Your ${usd2(needed)} USDC deposit is back in your wallet.`);
  await expect(page.getByRole('dialog', { name: 'Paid back' })).toBeVisible();
  line = await waitFor('repay lands', () => readLine(w.address), (l) => l?.drawn === 0n);
  expect(line!.deposit).toBe(0n);
  expect(line!.repaidOnTime).toBe(0); // repaid within seconds: a repayment counts only for >= 5 USDC held >= 7 days
  expect(line!.repaidLate).toBe(0);
  expect(await tokenBalance(w.address)).toBe(balBeforeRepay - payoff + needed);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - fee);
  const pool2 = await readPool();
  expect(pool2.stats.outstanding).toBe(pool0.stats.outstanding);
  expect(pool2.stats.feesEarned - pool0.stats.feesEarned).toBe(fee);
  await page.getByRole('dialog', { name: 'Paid back' }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('available')).toHaveText(`${usd2(limit)}USDC`);
  await expect(page.getByTestId('on-time')).toHaveText('0');
  await shot('repaid');

  // --- put a deposit down, then take it back --------------------------------------------------------------
  log('deposit again, then withdraw the deposit');
  await page.getByRole('button', { name: 'Borrow', exact: true }).click();
  await page.locator('#amt').fill(plain(draw));
  await page.getByRole('button', { name: `Add ${usdFull(needed)} USDC deposit` }).click();
  await expect(toast(page, `Deposit added: ${usdFull(needed)} USDC.`)).toBeVisible();
  await waitFor('second deposit lands', () => readLine(w.address), (l) => l?.deposit === needed);
  await back(page);
  await expect(page.getByText(`${usdFull(needed)} USDC is waiting for you.`)).toBeVisible();
  await shot('deposit-waiting');
  await page.getByRole('button', { name: `Withdraw ${usdFull(needed)} USDC` }).click();
  await expect(toast(page, 'Deposit returned to your wallet.')).toBeVisible();
  line = await waitFor('withdraw lands', () => readLine(w.address), (l) => l?.deposit === 0n);
  expect(line!.drawn).toBe(0n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - fee);
  await expect(page.getByTestId('wallet-usdc')).toHaveText(usd2(walletUsdc0 - fee));
  await shot('withdrawn');
  if (o.shots) await noOverflow();

  expect(s.pageErrors, 'uncaught errors in the page').toEqual([]);
  return { limit, draw, fee, needed };
}

/** Flow 5, part 1: borrow some, then look at the mark-default control while the loan is not overdue. */
async function markDefaultNotOverdue(s: Session, due: bigint) {
  const { page, wallet: w, context } = s;
  log('mark-default control on a loan that is out and not overdue');
  await openTab(page, 'pool');
  const panel = page.locator('.mark-default');
  const button = panel.getByRole('button', { name: 'Mark as defaulted' });
  await expect(button).toBeDisabled();
  await panel.getByLabel('Borrower wallet').fill(w.address);
  await expect(panel.locator('.notice')).toContainText('Not overdue');
  await expect(panel.locator('.notice')).toContainText('Too early to mark.');
  await expect(button).toBeDisabled();

  // Fool the page: a second browser, same wallet, whose clock is 40 days ahead. The page then believes the loan is
  // overdue and enables the button, but the program checks the real chain time and refuses before any signature.
  const skew = await openSession(context.browser()!, w);
  try {
    await skew.page.goto('/#pool');
    await skew.page.clock.setFixedTime(new Date((Number(due) + 10 * 86_400) * 1000));
    await connectWallet(skew.page, w);
    const p2 = skew.page.locator('.mark-default');
    await p2.getByLabel('Borrower wallet').fill(w.address);
    await expect(p2.locator('.notice')).toContainText('Overdue');
    const b2 = p2.getByRole('button', { name: 'Mark as defaulted' });
    await expect(b2).toBeEnabled();
    const signedBefore = w.signCount;
    await b2.click();
    await expect(failure(skew.page, ERROR_MESSAGES.NotPastDue)).toBeVisible();
    await expect(failure(skew.page, ERROR_MESSAGES.NotPastDue).locator('pre')).toHaveCount(1);
    expect(w.signCount, 'refused before the wallet was asked to sign').toBe(signedBefore);
    const l = await readLine(w.address);
    expect(l!.defaulted).toBe(false);
    expect(l!.drawn).toBeGreaterThan(0n);
  } finally {
    await skew.close();
  }
}

// ============================================================================================================
// The tests
// ============================================================================================================
test.describe('Notch, browser end to end', () => {
  test('1. Borrow: connect, inbox, live status, post, deposit, slide to borrow, repay, take the deposit back', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), USDC(20));
    const baseline = await readPool();
    saveState({ baseline: baselineToJson(baseline) });
    const s = await openSession(browser, w);
    try {
      const r = await borrowFlow(s, { extras: true });
      saveState({ borrow: { wallet: w.address, draw: r.draw.toString(), fee: r.fee.toString() } });
    } catch (e) {
      await s.page.screenshot({ path: 'e2e/test-results/flow1-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('2. Lend (Risky): deposit, request, countdown, claim window, early claim refused, lapsed, cancel', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), USDC(10));
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#lend');
      await expect(page.getByRole('heading', { name: 'Lend', exact: true })).toBeVisible();
      await connectWallet(page, w);
      await expect(page.getByTestId('lent-total')).toHaveText('0.00USDC');
      await page.getByRole('radio', { name: /Risky/ }).click();
      await expect(page.getByRole('radio', { name: /Risky/ })).toHaveAttribute('aria-checked', 'true');

      // deposit 5 USDC into Risky (junior)
      const deposit = USDC(5);
      const before = await readPool();
      const expShares = sharesForDeposit(deposit, before.shareSupply, before.stats.juniorNav);
      await page.getByRole('button', { name: 'Add to Risky' }).click();
      const dep = page.getByRole('dialog', { name: 'Add to Risky' });
      await dep.getByLabel('Amount').fill('5');
      await expect(dep).toContainText('It grows with the fees Risky earns');
      await dep.getByRole('button', { name: 'Deposit 5.00 USDC' }).click();
      await expect(toast(page, `Deposited 5.00 USDC into Risky for ${usdFull(expShares)} shares.`)).toBeVisible();
      const shares = await waitFor('shares minted', () => shareBalance(w.address), (v) => v > 0n);
      expect(shares).toBe(expShares);
      expect(await tokenBalance(w.address)).toBe(USDC(5));
      const afterDeposit = await readPool();
      expect(afterDeposit.stats.idle - before.stats.idle).toBe(deposit);
      expect(afterDeposit.stats.juniorNav - before.stats.juniorNav).toBe(deposit);
      expect(afterDeposit.shareSupply - before.shareSupply).toBe(shares);
      await page.keyboard.press('Escape');
      const worth = (shares * afterDeposit.stats.juniorNav) / afterDeposit.shareSupply;
      await expect(page.getByTestId('yours-junior')).toHaveText(usd2r(worth));

      // request withdrawal: shares move to escrow, supply unchanged; the sheet shows the 3 dates
      await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
      const wd = page.getByRole('dialog', { name: 'Withdraw takes 3 days' });
      await expect(wd).toContainText('Claim by this day');
      await expect(wd).toContainText('Today’s price is the most you can get');
      await wd.getByRole('button', { name: 'All' }).click();
      await expect(wd.getByLabel('USDC to take out of Risky')).toHaveValue(plain(worth));
      await wd.getByRole('button', { name: 'Request withdrawal' }).click();
      await expect(toast(page, `Requested ${usdFull(shares)} Risky shares. You can claim in 3 days, within 2 days after that.`)).toBeVisible();
      const req = await waitFor('request exists', () => readWithdrawRequest(w.address), (r) => r !== null);
      expect(req!.lender).toBe(w.address);
      expect(req!.shares).toBe(shares);
      const nowS = BigInt(Math.floor(Date.now() / 1000));
      expect(req!.unlockTs).toBeGreaterThan(nowS + WITHDRAW_COOLDOWN_SECONDS - 600n);
      expect(req!.unlockTs).toBeLessThan(nowS + WITHDRAW_COOLDOWN_SECONDS + 600n);
      expect(req!.navAtRequest).toBe(afterDeposit.stats.juniorNav);
      expect(req!.supplyAtRequest).toBe(afterDeposit.shareSupply);
      expect(await shareBalance(w.address)).toBe(0n);
      expect(await escrowShares(w.address)).toBe(shares);
      expect((await readPool()).shareSupply).toBe(afterDeposit.shareSupply);
      await page.keyboard.press('Escape');

      // the pending card: countdown ticking, unlock date and the 2-day claim window both shown
      const card = page.getByTestId('pending-junior');
      await expect(card.locator('.tag')).toHaveText('WAITING');
      const countdown = card.getByTestId('countdown');
      await expect(countdown).toHaveText(/^2d \d{2}:\d{2}:\d{2}$/);
      const t1 = await countdown.innerText();
      await expect(countdown).not.toHaveText(t1, { timeout: 5_000 });
      await expect(card).toContainText('Unlocks');
      await expect(card).toContainText('Claim by');
      await expect(card).toContainText('a 2-day window');
      const claim = card.getByRole('button', { name: 'Claim USDC' });
      await expect(claim).toBeDisabled();

      // A wallet whose clock is 4 days fast: the page thinks the claim window is open, the program does not.
      await page.clock.setFixedTime(new Date(Date.now() + 4 * 86_400_000));
      await expect(card.locator('.tag')).toHaveText('READY TO CLAIM');
      await expect(card).toContainText('Claim window closes in');
      await expect(claim).toBeEnabled();
      const signed = w.signCount;
      await claim.click();
      await expect(failure(page, ERROR_MESSAGES.CooldownActive)).toBeVisible();
      await expect(failure(page, ERROR_MESSAGES.CooldownActive).locator('summary')).toHaveText('Show the real error');
      expect(w.signCount, 'refused before the wallet was asked to sign').toBe(signed);
      expect(await tokenBalance(w.address)).toBe(USDC(5));
      expect(await escrowShares(w.address)).toBe(shares);

      // past unlock + 2 days: the window has lapsed, only cancel is offered
      await page.clock.setFixedTime(new Date((Number(req!.unlockTs) + Number(CLAIM_WINDOW_SECONDS) + 3600) * 1000));
      await expect(card.locator('.tag')).toHaveText('WINDOW CLOSED');
      await expect(card).toContainText('The 2-day claim window has closed. Cancel to get your shares back, then ask again.');
      await expect(claim).toBeDisabled();

      // cancel: shares come back, accounts close
      await card.getByRole('button', { name: 'Cancel and get shares back' }).click();
      await expect(toast(page, 'Cancelled. Your shares are back in your wallet.')).toBeVisible();
      expect(await waitFor('shares back', () => shareBalance(w.address), (v) => v === shares)).toBe(shares);
      expect(await waitFor('request closed', () => readWithdrawRequest(w.address), (r) => r === null)).toBeNull();
      expect(await escrowShares(w.address)).toBeNull();
      expect((await readPool()).shareSupply).toBe(afterDeposit.shareSupply);
      await expect(card).toBeHidden();
      saveState({ lend: { wallet: w.address, deposit: deposit.toString(), shares: shares.toString() } });
      expect(s.pageErrors, 'uncaught errors in the page').toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow2-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('3. Pool: totals match the chain and moved after flows 1 and 2', async ({ browser }) => {
    const st = loadState();
    expect(st.baseline, 'flow 1 has not run (no baseline)').toBeTruthy();
    expect(st.borrow, 'flow 1 has not run').toBeTruthy();
    expect(st.lend, 'flow 2 has not run').toBeTruthy();
    const base = baselineFromJson(st.baseline!);
    const now = await readPool();
    const draw = BigInt(st.borrow!.draw);
    const fee = BigInt(st.borrow!.fee);
    const dep = BigInt(st.lend!.deposit);
    const shares = BigInt(st.lend!.shares);

    // on chain: exactly what the two flows did (assumes nobody else used the pool in between)
    expect(now.stats.totalLent - base.stats.totalLent).toBe(draw);
    expect(now.stats.feesEarned - base.stats.feesEarned).toBe(fee);
    expect(now.stats.idle - base.stats.idle).toBe(fee + dep);
    expect(now.stats.outstanding).toBe(base.stats.outstanding);
    expect(now.stats.borrowerDeposits).toBe(base.stats.borrowerDeposits);
    expect(now.shareSupply - base.shareSupply).toBe(shares);

    const w = await fundedWallet(SOL(0.003), 0n);
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#pool');
      await expect(page.getByRole('heading', { name: 'The loan book' })).toBeVisible();
      const totals = page.getByTestId('totals');
      const v = (label: string) => stat(totals, label).locator('.stat-value');
      await expect(v('Lent out, all time')).toHaveText(usd2(now.stats.totalLent));
      await expect(v('Out on loan now')).toHaveText(usd2(now.stats.outstanding));
      await expect(v('Cash ready to lend')).toHaveText(usd2(now.stats.idle));
      await expect(v('Fees earned')).toHaveText(usd2(now.stats.feesEarned));
      await expect(v('Missed payments')).toHaveText(String(now.stats.defaults));
      await expect(v('Borrower deposits')).toHaveText(usd2(now.stats.borrowerDeposits));
      const health = page.getByTestId('health');
      await expect(stat(health, 'Risky shares').locator('.stat-value')).toHaveText(usd2(now.shareSupply));
      const price = (now.stats.juniorNav * 1_000_000n) / now.shareSupply;
      await expect(stat(health, 'Risky share price').locator('.stat-value')).toHaveText(`${price / 1_000_000n}.${(price % 1_000_000n).toString().padStart(6, '0')}`);
      // no borrower list and no income
      await expect(page.locator('main')).not.toContainText(st.borrow!.wallet);
      await expect(page.locator('.visibility')).toContainText('Payment amounts and income');
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow3-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('4. Try to cheat it: edited email, same email twice, limit signed by the wrong key', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.01), 0n);
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#pool');
      await connectWallet(page, w);
      await page.getByRole('button', { name: /Try to cheat it/ }).click();
      await expect(page.getByRole('heading', { name: 'Try to cheat it', level: 1 })).toBeVisible();
      const card = (title: string) => page.locator('section.attack').filter({ has: page.getByRole('heading', { name: title }) });

      const a = card('Edit the email');
      await a.getByRole('button', { name: 'Edit and send' }).click();
      await expect(a.locator('li.blocked')).toHaveCount(1, { timeout: 90_000 });
      await expect(a).toContainText('Changed ');
      await expect(a.locator('li.blocked .verdict')).toHaveText('Blocked');
      await expect(a).toContainText('The email’s digital signature does not check out. It was edited after the sender signed it, or it did not come from a provider we accept.');
      await expect(a.locator('li.blocked pre')).toContainText(/dkim/i);
      await expect(a.locator('li.leaked')).toHaveCount(0);

      const b = card('Use the same email twice');
      await b.getByRole('button', { name: 'Send it twice' }).click();
      await expect(b.locator('li.blocked')).toHaveCount(1, { timeout: 120_000 });
      await expect(b.locator('li').first()).toContainText('Accepted: limit');
      await expect(b).toContainText('The sealed computer has already used this email. Each email counts once.');
      await expect(b.locator('li.leaked')).toHaveCount(0);

      const c = card('Sign a limit ourselves');
      const signedBefore = w.signCount;
      await c.getByRole('button', { name: 'Forge and submit (dry run)' }).click();
      await expect(c.locator('li.blocked')).toHaveCount(1, { timeout: 60_000 });
      await expect(c).toContainText(ERROR_MESSAGES.WrongUnderwriter);
      await expect(c.locator('li.blocked pre')).toContainText('WrongUnderwriter');
      await expect(c.locator('li.leaked')).toHaveCount(0);
      expect(w.signCount, 'a dry run must not ask the wallet to sign').toBe(signedBefore);
      expect(await readLine(w.address)).toBeNull();
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow4-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('5. Mark-default stays disabled when nothing is overdue; empty and error states', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.003), 0n);
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#pool');
      const panel = page.locator('.mark-default');
      const button = panel.getByRole('button', { name: 'Mark as defaulted' });
      await expect(panel.getByText('Connect a wallet to send this.')).toBeVisible();
      await expect(button).toBeDisabled();

      await connectWallet(page, w);
      await expect(button).toBeDisabled();
      await panel.getByLabel('Borrower wallet').fill('not-a-wallet');
      await expect(panel).toContainText('That is not a valid wallet address.');
      await expect(button).toBeDisabled();
      await panel.getByLabel('Borrower wallet').fill(w.address);
      await expect(panel.locator('.notice')).toContainText('This wallet has no credit line here.');
      await expect(button).toBeDisabled();
      const borrowed = loadState().borrow?.wallet;
      expect(borrowed, 'flow 1 has not run').toBeTruthy();
      await panel.getByLabel('Borrower wallet').fill(borrowed!);
      await expect(panel.locator('.notice')).toContainText('Not overdue');
      await expect(panel.locator('.notice')).toContainText('Nothing is borrowed right now.');
      await expect(button).toBeDisabled();

      // empty states: no limit yet on Borrow; the sealed computer refuses an edited upload in plain words
      await page.goto('/#borrow');
      await expect(page.getByText('No limit yet')).toBeVisible();
      await page.getByRole('button', { name: 'Get my limit' }).click();
      await page.getByRole('button', { name: 'Bank statement sample' }).click();
      await expect(page.getByText('Ready: bank.eml')).toBeVisible();
      // the sealed computer goes away mid-session: a plain-words error, no crash
      await page.route('**/underwrite', (r) => r.abort('connectionrefused'));
      await page.getByRole('button', { name: 'Send to the sealed computer' }).click();
      await expect(page.locator('.notice-bad')).toContainText('Is it running?');
      await page.unroute('**/underwrite');
      expect(w.signCount).toBe(0);
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow5-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('6. Phone (390x844): borrow flow with a screenshot per step', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), USDC(20));
    const s = await openSession(browser, w, { phone: true });
    try {
      expect(s.page.viewportSize()).toEqual(PHONE.viewport);
      await borrowFlow(s, { shots: 'phone' });
      // and the lend and pool tabs at phone size
      await s.page.goto('/#lend');
      await expect(s.page.getByTestId('lent-total')).toBeVisible();
      await screenshot(s.page, 'phone', 20, 'lend');
      await s.page.goto('/#pool');
      await expect(s.page.getByTestId('totals')).toBeVisible();
      await screenshot(s.page, 'phone', 21, 'pool');
    } catch (e) {
      await s.page.screenshot({ path: 'e2e/test-results/flow6-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
function baselineToJson(p: Awaited<ReturnType<typeof readPool>>): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(p.stats).map(([k, v]) => [k, String(v)])), shareSupply: String(p.shareSupply), vault: String(p.vault) };
}
function baselineFromJson(j: Record<string, string>) {
  const { shareSupply, vault, ...stats } = j;
  return {
    stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, BigInt(v)])) as unknown as Awaited<ReturnType<typeof readPool>>['stats'],
    shareSupply: BigInt(shareSupply),
    vault: BigInt(vault),
  };
}
