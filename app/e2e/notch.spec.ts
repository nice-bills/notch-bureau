// Browser end-to-end tests. Everything is real: Chromium, the Vite app, a Wallet Standard test wallet that signs
// in Node, the demo underwriter on :8787 (real DKIM check on freshly signed emails) and the Notch program on devnet.
// Each flow clicks through the UI, asserts the visible text, then reads the account back from devnet.
import { expect, test, type Page } from '@playwright/test';
import nacl from 'tweetnacl';
import { address, getAddressEncoder } from '@solana/kit';
import {
  WITHDRAW_COOLDOWN_SECONDS,
  base64ToBytes,
  decodeRecord,
  depositNeededFor,
  feeFor,
  payoffFor,
  sharesForDeposit,
  poolAssets,
} from '../src/notch.ts';
import { ERROR_MESSAGES } from '../src/errors.ts';
import {
  USDC_UNIT,
  escrowShares,
  readLine,
  readPool,
  readUnderwriter,
  readWithdrawRequest,
  shareBalance,
  tokenBalance,
  waitFor,
} from './chain.ts';
import { ENCLAVE_URL } from './env.ts';
import { loadState, saveState } from './state.ts';
import {
  PHONE,
  connectWallet,
  fundedWallet,
  log,
  openSession,
  openTab,
  screenshot,
  stat,
  stepCard,
  plain,
  usd2,
  usd4,
  usdFull,
  type Session,
} from './app.ts';
import type { TestWallet } from './wallet.ts';

const SOL = (n: number) => BigInt(Math.round(n * 1e9));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const APP = '/#borrow';

/** Strings from the MoMo sample that must never reach the page: the income, the balance, names, the sender's number. */
const SECRETS_IN_MOMO_EMAIL = ['1,250', '1250', '1,300', '1300', 'GHS', 'KWAME', 'ASANTE', 'KOFI', 'MENSAH', '024 000', 'MP261122', 'design work'];

const toast = (page: Page, text: string | RegExp) => page.locator('.action-status.good').filter({ hasText: text });
const failure = (page: Page, text: string | RegExp) => page.locator('.action-status.bad').filter({ hasText: text });

// ============================================================================================================
// Flow 1 (and flow 6): borrow end to end. `phone` adds a screenshot per step.
// ============================================================================================================
async function borrowFlow(s: Session, o: { shots?: string; extras?: boolean }) {
  const { page, wallet: w } = s;
  let n = 0;
  const shot = async (name: string) => { if (o.shots) await screenshot(page, o.shots, ++n, name); };
  const noOverflow = async () => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw, 'page scrolls sideways').toBeLessThanOrEqual(cw);
  };

  await page.goto(APP);
  await expect(page.getByRole('heading', { name: 'Borrow against your income, without showing it' })).toBeVisible();
  // the sealed computer status is read from the running demo enclave
  await expect(page.locator('.status-line')).toContainText('Sealed computer');
  await shot('open');

  // --- connect ---------------------------------------------------------------------------------------
  log('connect through the wallet picker');
  await connectWallet(page, w);
  await expect(stepCard(page, 'Connect your wallet')).toContainText(`Connected as ${w.address}`);
  await expect(page.getByText('No line yet. Send an income email to get one.')).toBeVisible();
  await shot('connected');
  if (o.shots) await noOverflow();

  // --- MoMo sample -> sealed computer -----------------------------------------------------------------
  log('load the MoMo sample, send it to the sealed computer');
  await page.getByRole('button', { name: 'MTN MoMo payment' }).click();
  await expect(page.locator('.file-name')).toHaveText('momo.eml');
  await shot('sample-loaded');
  const reply = page.waitForResponse((r) => r.url().endsWith('/underwrite') && r.request().method() === 'POST', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Send to the sealed computer' }).click();
  const underwriteRes = await reply;
  expect(underwriteRes.status()).toBe(200);
  const replyJson = (await underwriteRes.json()) as Record<string, unknown>;

  const ticket = page.getByRole('figure', { name: 'What left the sealed computer' });
  await expect(ticket).toBeVisible({ timeout: 120_000 });
  await shot('what-left');
  if (o.shots) await noOverflow();

  // What left the sealed computer: only a limit and a signature.
  expect(Object.keys(replyJson).sort()).toEqual(['expiry', 'extraction', 'limitUsdc', 'message', 'nonce', 'ok', 'signature']);
  const record = decodeRecord(base64ToBytes(replyJson.message as string));
  const limit = record.limitMicro;
  expect(limit).toBeGreaterThan(0n);
  await expect(ticket).toContainText('USDC credit limit');
  await expect(ticket.locator('.ticket-num')).toHaveText(usd2(limit));
  await expect(ticket.locator('.ticket-facts dt')).toHaveText(['Made for wallet', 'Good until', 'Email fingerprint', 'Counter']);
  await expect(ticket.locator('.ticket-sig .mono')).toContainText('…');
  await expect(ticket).toContainText('Stayed inside');
  // the record is for this wallet and the signature is a real signature by the key the program trusts
  const rawRecord = base64ToBytes(replyJson.message as string);
  expect(Buffer.from(rawRecord.subarray(8, 40)).equals(Buffer.from(getAddressEncoder().encode(address(w.address))))).toBe(true);
  const uwKey = new Uint8Array(getAddressEncoder().encode(address(await readUnderwriter())));
  expect(nacl.sign.detached.verify(rawRecord, base64ToBytes(replyJson.signature as string), uwKey)).toBe(true);

  // raw reply view
  await page.locator('details.raw-reply summary').click();
  const rawText = await page.locator('details.raw-reply pre').innerText();
  expect(Object.keys(JSON.parse(rawText)).sort()).toEqual(['expiry', 'extraction', 'limitUsdc', 'message', 'nonce', 'ok', 'signature']);
  await shot('raw-reply');
  // No income amount, balance, name or phone number anywhere: rendered text, hidden text, the whole HTML, the raw reply and the network reply.
  const pageText = await page.evaluate(() => document.body.innerText);
  const pageHtml = await page.content();
  const pageContent = await page.evaluate(() => document.body.textContent ?? '');
  const networkText = JSON.stringify(replyJson);
  for (const secret of SECRETS_IN_MOMO_EMAIL) {
    // The base64 of the signed record and its signature are random-looking text: a short secret like "GHS" shows up in it by chance (about 1 run in 50).
    const noB64 = (t: string) => t.split(String(replyJson.message)).join('').split(String(replyJson.signature)).join('');
    for (const [where, hay] of [['visible text', pageText], ['page text', pageContent], ['page HTML', pageHtml], ['raw reply', rawText], ['network reply', networkText]] as const) {
      expect(noB64(hay).toLowerCase().includes(secret.toLowerCase()), `"${secret}" leaked into the ${where}`).toBe(false);
    }
  }
  // nothing was posted yet
  expect(await readLine(w.address)).toBeNull();

  // --- post the limit ---------------------------------------------------------------------------------
  log('post the limit');
  await page.getByRole('button', { name: 'Post my limit' }).click();
  await expect(toast(page, 'Your limit is now on Solana.')).toBeVisible();
  let line = await waitFor('credit line exists', () => readLine(w.address), (l) => l !== null);
  expect(line!.wallet).toBe(w.address);
  expect(line!.limit).toBe(limit);
  expect(line!.expiry).toBe(record.expiry);
  expect(line!.lastNonce).toBe(record.nonce);
  expect(line!.drawn).toBe(0n);
  expect(line!.deposit).toBe(0n);
  expect(line!.defaulted).toBe(false);
  await expect(stat(page.locator('.line-card'), 'Limit').locator('.stat-value')).toHaveText(usd2(limit));
  await expect(stepCard(page, 'Put your limit on Solana')).toContainText('Valid until');
  await shot('limit-posted');

  // --- choose an amount, deposit 20% ----------------------------------------------------------------------
  const draw = limit >= USDC(4) ? USDC(4) : (limit / 2n / 10_000n) * 10_000n;
  expect(draw).toBeGreaterThan(0n);
  const needed = depositNeededFor(draw);
  const fee = feeFor(draw);
  const payoff = payoffFor(draw);
  expect(payoff).toBe(draw + fee);
  const walletUsdc0 = await tokenBalance(w.address);
  const pool0 = await readPool();

  log(`deposit 20% (${usdFull(needed)}) for a ${usdFull(draw)} draw`);
  await page.getByLabel('How much do you want to borrow?').fill(plain(draw));
  const calc = stepCard(page, 'Choose an amount and put down 20%');
  await expect(calc.locator('.calc-total dd')).toHaveText(usdFull(needed));
  await expect(calc).toContainText(`Deposit needed (20%)${usdFull(needed)}`);
  await expect(page.getByLabel('Deposit to add')).toHaveValue(plain(needed));
  await shot('amount-chosen');
  await page.getByRole('button', { name: 'Add deposit' }).click();
  await expect(toast(page, `Deposit added: ${usdFull(needed)} USDC.`)).toBeVisible();
  line = await waitFor('deposit lands', () => readLine(w.address), (l) => l?.deposit === needed);
  expect(line!.drawn).toBe(0n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - needed);
  expect((await readPool()).stats.borrowerDeposits).toBe(pool0.stats.borrowerDeposits + needed);
  await expect(stat(page.locator('.line-card'), 'Your deposit').locator('.stat-value')).toHaveText(usd2(needed));
  await shot('deposit-added');

  // --- draw ---------------------------------------------------------------------------------------------
  log(`draw ${usdFull(draw)}`);
  await page.getByRole('button', { name: `Borrow ${usdFull(draw)} USDC` }).click();
  await expect(toast(page, `${usdFull(draw)} USDC sent to your wallet.`)).toBeVisible();
  line = await waitFor('draw lands', () => readLine(w.address), (l) => l?.drawn === draw);
  expect(line!.deposit).toBe(needed);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  expect(line!.due).toBeGreaterThan(nowS + 29n * 86_400n);
  expect(line!.due).toBeLessThan(nowS + 31n * 86_400n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - needed + draw);
  const pool1 = await readPool();
  expect(pool1.stats.outstanding - pool0.stats.outstanding).toBe(draw);
  expect(pool1.stats.totalLent - pool0.stats.totalLent).toBe(draw);
  await expect(stat(page.locator('.line-card'), 'Borrowed').locator('.stat-value')).toHaveText(usd2(draw));
  await expect(stepCard(page, 'Repay')).toContainText(`Pay back in one go${usdFull(payoff)}`);
  await expect(stepCard(page, 'Repay')).toContainText(`Fee (2%, rounded up)${usdFull(fee)}`);
  await shot('drawn');
  if (o.shots) await noOverflow();

  // --- (flow 5, part 1) the mark-default control for a loan that is out but not overdue -------------------------
  if (o.extras) await markDefaultNotOverdue(s, line!.due);

  // --- repay principal + 2% ---------------------------------------------------------------------------------
  log(`repay ${usdFull(payoff)}`);
  if (page.url().includes('#book')) await openTab(page, 'borrow');
  const balBeforeRepay = await tokenBalance(w.address);
  await page.getByRole('button', { name: `Repay ${usdFull(payoff)} USDC` }).click();
  await expect(toast(page, `Repaid ${usdFull(payoff)} USDC. Your ${usdFull(needed)} USDC deposit came back to you.`)).toBeVisible();
  line = await waitFor('repay lands', () => readLine(w.address), (l) => l?.drawn === 0n);
  expect(line!.deposit).toBe(0n);
  expect(line!.repaidOnTime).toBe(0); // drawn and repaid within seconds: a repayment counts only for >= 5 USDC held >= 7 days, once per 14 days (audit #2, final gate #1)
  expect(line!.repaidLate).toBe(0);
  expect(await tokenBalance(w.address)).toBe(balBeforeRepay - payoff + needed);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - fee);
  const pool2 = await readPool();
  expect(pool2.stats.outstanding).toBe(pool0.stats.outstanding);
  expect(pool2.stats.feesEarned - pool0.stats.feesEarned).toBe(fee);
  await expect(stat(page.locator('.line-card'), 'Borrowed').locator('.stat-value')).toHaveText('0.00');
  await expect(stat(page.locator('.line-card'), 'Repaid on time').locator('.stat-value')).toHaveText('0');
  await shot('repaid');

  // --- put the deposit back, then withdraw it ----------------------------------------------------------------
  log('deposit again, then withdraw the deposit');
  await page.getByLabel('How much do you want to borrow?').fill(plain(draw));
  await expect(page.getByLabel('Deposit to add')).toHaveValue(plain(needed));
  await page.getByRole('button', { name: 'Add deposit' }).click();
  await expect(toast(page, `Deposit added: ${usdFull(needed)} USDC.`)).toBeVisible();
  await waitFor('second deposit lands', () => readLine(w.address), (l) => l?.deposit === needed);
  await expect(stepCard(page, 'Take your deposit back')).toContainText(`${usdFull(needed)} USDC is waiting for you.`);
  await shot('deposit-waiting');
  await page.getByRole('button', { name: `Withdraw ${usdFull(needed)} USDC` }).click();
  await expect(toast(page, 'Deposit returned to your wallet.')).toBeVisible();
  line = await waitFor('withdraw lands', () => readLine(w.address), (l) => l?.deposit === 0n);
  expect(line!.drawn).toBe(0n);
  expect(await tokenBalance(w.address)).toBe(walletUsdc0 - fee);
  await expect(page.locator('.side-balance strong')).toHaveText(usd2(walletUsdc0 - fee));
  await shot('withdrawn');
  if (o.shots) await noOverflow();

  // --- (flow 4, program side) the same email posted to Solana a second time is refused ----------------------
  if (o.extras) {
    log('same email posted to Solana again is refused by the program');
    await openTab(page, 'attack');
    const signedBeforeAttack = w.signCount;
    await page.getByRole('button', { name: 'Send it twice' }).click();
    const card = page.locator('section.attack').filter({ hasText: 'Use the same email twice' });
    await expect(card.getByText('Same email, posted to Solana again: program')).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('li.blocked')).toHaveCount(2); // sealed computer + program both said no
    await expect(card).toContainText('The sealed computer has already used this email. Each email counts once.');
    await expect(card).toContainText('This email has already been used to set a limit. Each email only counts once.');
    expect(w.signCount, 'a dry run must not ask the wallet to sign').toBe(signedBeforeAttack);
  }

  expect(s.pageErrors, 'uncaught errors in the page').toEqual([]);
  return { limit, draw, fee, needed };
}

/** Flow 5, part 1: borrow some, then look at the mark-default control while the loan is not overdue. */
async function markDefaultNotOverdue(s: Session, due: bigint) {
  const { page, wallet: w, context } = s;
  log('mark-default control on a loan that is out and not overdue');
  await openTab(page, 'book');
  const panel = page.locator('.mark-default');
  const button = panel.getByRole('button', { name: 'Mark as defaulted' });
  await expect(button).toBeDisabled(); // nothing typed yet
  await panel.getByLabel('Borrower wallet').fill(w.address);
  await expect(panel.locator('.notice')).toContainText('Not overdue');
  await expect(panel.locator('.notice')).toContainText('Too early to mark.');
  await expect(button).toBeDisabled();
  await expect(button).not.toBeEnabled();

  // Fool the page: a second browser, same wallet, whose clock is 40 days ahead. The page then believes the
  // loan is overdue and enables the button, but the program checks the real chain time and refuses.
  const skew = await openSession(context.browser()!, w);
  try {
    await skew.page.goto('/#book');
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
test.describe('Notch Bureau, browser end to end', () => {
  test('1. Borrow: connect, sealed computer, post, deposit, draw, repay, withdraw', async ({ browser }) => {
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

  test('2. Lend: deposit, request withdrawal, countdown, early claim refused, cancel', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.02), USDC(10));
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#lend');
      await expect(page.getByRole('heading', { name: 'Lend to students, earn the 2% fees' })).toBeVisible();
      await connectWallet(page, w);
      await expect(stat(page, 'Wallet USDC').locator('.stat-value')).toHaveText('10.00');

      // deposit 5 USDC
      const deposit = USDC(5);
      const before = await readPool();
      const expShares = sharesForDeposit(deposit, before.shareSupply, poolAssets(before.stats));
      const panel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Deposit', exact: true }) });
      await panel.locator('input').fill('5');
      await expect(panel).toContainText(`You receive about ${usdFull(expShares)} shares`);
      await panel.getByRole('button', { name: 'Deposit USDC' }).click();
      await expect(toast(page, `Deposited 5.00 USDC for ${usdFull(expShares)} shares.`)).toBeVisible();
      const shares = await waitFor('shares minted', () => shareBalance(w.address), (v) => v > 0n);
      expect(shares).toBe(expShares);
      expect(await tokenBalance(w.address)).toBe(USDC(5));
      const afterDeposit = await readPool();
      expect(afterDeposit.stats.idle - before.stats.idle).toBe(deposit);
      expect(afterDeposit.shareSupply - before.shareSupply).toBe(shares);
      await expect(stat(page, 'Your shares').locator('.stat-value')).toHaveText(usd4(shares));
      await expect(stat(page, 'Wallet USDC').locator('.stat-value')).toHaveText('5.00');

      // request withdrawal: shares move to escrow, supply unchanged
      const wd = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Withdraw', exact: true }) });
      await wd.getByRole('button', { name: 'All' }).click();
      await expect(wd.locator('input')).toHaveValue(plain(shares));
      await wd.getByRole('button', { name: 'Request withdrawal' }).click();
      await expect(toast(page, `Requested ${usdFull(shares)} shares. You can claim in 3 days.`)).toBeVisible();
      const req = await waitFor('request exists', () => readWithdrawRequest(w.address), (r) => r !== null);
      expect(req!.lender).toBe(w.address);
      expect(req!.shares).toBe(shares);
      const nowS = BigInt(Math.floor(Date.now() / 1000));
      expect(req!.unlockTs).toBeGreaterThan(nowS + WITHDRAW_COOLDOWN_SECONDS - 600n);
      expect(req!.unlockTs).toBeLessThan(nowS + WITHDRAW_COOLDOWN_SECONDS + 600n);
      expect(await shareBalance(w.address)).toBe(0n);
      expect(await escrowShares(w.address)).toBe(shares);
      expect((await readPool()).shareSupply).toBe(afterDeposit.shareSupply); // escrowed shares still count

      // countdown visible and ticking
      const countdown = stat(page, 'Unlocks in').locator('.stat-value');
      await expect(countdown).toHaveText(/^2d \d{2}:\d{2}:\d{2}$/);
      const t1 = await countdown.innerText();
      await expect(countdown).not.toHaveText(t1, { timeout: 5_000 });
      await expect(stat(page, 'Waiting to withdraw').locator('.stat-value')).toHaveText(usd4(shares));
      const claim = page.getByRole('button', { name: 'Claim USDC' });
      await expect(claim).toBeDisabled();

      // A wallet whose clock is 4 days fast: the page thinks the wait is over, the program does not.
      await page.clock.setFixedTime(new Date(Date.now() + 4 * 86_400_000));
      await expect(stat(page, 'Ready').locator('.stat-value')).toHaveText('Now');
      await expect(claim).toBeEnabled();
      const signed = w.signCount;
      await claim.click();
      await expect(failure(page, ERROR_MESSAGES.CooldownActive)).toBeVisible();
      await expect(failure(page, ERROR_MESSAGES.CooldownActive).locator('summary')).toHaveText('Show the real error');
      expect(w.signCount, 'refused before the wallet was asked to sign').toBe(signed);
      expect(await tokenBalance(w.address)).toBe(USDC(5)); // nothing was paid
      expect(await escrowShares(w.address)).toBe(shares);

      // cancel: shares come back, accounts close
      await page.getByRole('button', { name: 'Cancel and get shares back' }).click();
      await expect(toast(page, 'Cancelled. Your shares are back in your wallet.')).toBeVisible();
      expect(await waitFor('shares back', () => shareBalance(w.address), (v) => v === shares)).toBe(shares);
      expect(await waitFor('request closed', () => readWithdrawRequest(w.address), (r) => r === null)).toBeNull();
      expect(await escrowShares(w.address)).toBeNull();
      expect((await readPool()).shareSupply).toBe(afterDeposit.shareSupply);
      await expect(stat(page, 'Your shares').locator('.stat-value')).toHaveText(usd4(shares));
      await expect(page.getByRole('button', { name: 'Request withdrawal' })).toBeVisible();
      saveState({ lend: { wallet: w.address, deposit: deposit.toString(), shares: shares.toString() } });
      expect(s.pageErrors, 'uncaught errors in the page').toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow2-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('3. Loan book: totals match the chain and moved after flows 1 and 2', async ({ browser }) => {
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

    // on chain: exactly what the two flows did (assumes nobody else used the devnet pool in between)
    expect(now.stats.totalLent - base.stats.totalLent).toBe(draw);
    expect(now.stats.feesEarned - base.stats.feesEarned).toBe(fee);
    expect(now.stats.idle - base.stats.idle).toBe(fee + dep);
    expect(now.stats.outstanding).toBe(base.stats.outstanding);
    expect(now.stats.borrowerDeposits).toBe(base.stats.borrowerDeposits);
    expect(now.shareSupply - base.shareSupply).toBe(shares);

    const w = await fundedWallet(SOL(0.003), 0n); // a visitor; the book needs no wallet but this one stays idle
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#book');
      await expect(page.getByRole('heading', { name: 'The loan book, in totals only' })).toBeVisible();
      const totals = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Pool totals' }) });
      const v = (label: string) => stat(totals, label).locator('.stat-value');
      await expect(v('Lent out, all time')).toHaveText(usd2(now.stats.totalLent));
      await expect(v('Out on loan now')).toHaveText(usd2(now.stats.outstanding));
      await expect(v('Cash ready to lend')).toHaveText(usd2(now.stats.idle));
      await expect(v('Fees earned')).toHaveText(usd2(now.stats.feesEarned));
      await expect(v('Missed payments')).toHaveText(String(now.stats.defaults));
      await expect(v('Borrower deposits')).toHaveText(usd2(now.stats.borrowerDeposits));
      // and they changed by the right amount since before flow 1
      const uiNum = async (label: string) => Number((await v(label).innerText()).replace(/,/g, ''));
      expect(await uiNum('Lent out, all time') - Number(usd2(base.stats.totalLent).replace(/,/g, ''))).toBeCloseTo(Number(draw) / 1e6, 2);
      expect(await uiNum('Fees earned') - Number(usd2(base.stats.feesEarned).replace(/,/g, ''))).toBeCloseTo(Number(fee) / 1e6, 2);
      expect(await uiNum('Cash ready to lend') - Number(usd2(base.stats.idle).replace(/,/g, ''))).toBeCloseTo(Number(fee + dep) / 1e6, 1);
      const health = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Health' }) });
      await expect(stat(health, 'Shares outstanding').locator('.stat-value')).toHaveText(usd2(now.shareSupply));
      const assets = poolAssets(now.stats);
      const price = (assets * 1_000_000n) / now.shareSupply;
      await expect(stat(health, 'Share price').locator('.stat-value')).toHaveText(`${price / 1_000_000n}.${(price % 1_000_000n).toString().padStart(6, '0')}`);
      // the loan book shows no borrower list and no income
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

  test('4. Attack panel: edited email, same email twice, limit signed by the wrong key', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.01), 0n);
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#attack');
      await expect(page.getByRole('heading', { name: 'Try to cheat it' })).toBeVisible();
      await connectWallet(page, w);
      const card = (title: string) => page.locator('section.attack').filter({ has: page.getByRole('heading', { name: title }) });

      // A: edit the email
      const a = card('Edit the email');
      await a.getByRole('button', { name: 'Edit and send' }).click();
      await expect(a.locator('li.blocked')).toHaveCount(1, { timeout: 90_000 });
      await expect(a).toContainText('Changed ');
      await expect(a.locator('li.blocked .verdict')).toHaveText('Blocked');
      await expect(a).toContainText('The email’s digital signature does not check out. It was edited after the sender signed it, or it did not come from a provider we accept.');
      await expect(a.locator('li.blocked pre')).toContainText(/dkim/i);
      await expect(a.locator('li.leaked')).toHaveCount(0);

      // B: same email twice
      const b = card('Use the same email twice');
      await b.getByRole('button', { name: 'Send it twice' }).click();
      await expect(b.locator('li.blocked')).toHaveCount(1, { timeout: 120_000 });
      await expect(b.locator('li').first()).toContainText('Accepted: limit');
      await expect(b.locator('li.blocked .verdict')).toHaveText('Blocked');
      await expect(b).toContainText('The sealed computer has already used this email. Each email counts once.');
      await expect(b.locator('li.blocked pre')).toContainText(/email already used/i);
      await expect(b.locator('li.leaked')).toHaveCount(0);

      // C: a limit signed with our own key, submitted to the program (dry run)
      const c = card('Sign a limit ourselves');
      const signedBefore = w.signCount;
      await c.getByRole('button', { name: 'Forge and submit (dry run)' }).click();
      await expect(c.locator('li.blocked')).toHaveCount(1, { timeout: 60_000 });
      await expect(c).toContainText(ERROR_MESSAGES.WrongUnderwriter);
      await expect(c.locator('li.blocked pre')).toContainText('WrongUnderwriter');
      await expect(c.locator('li.leaked')).toHaveCount(0);
      expect(w.signCount, 'a dry run must not ask the wallet to sign').toBe(signedBefore);
      expect(await readLine(w.address)).toBeNull(); // nothing reached the chain
      expect(s.pageErrors).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: 'e2e/test-results/flow4-failure.png', fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await s.close();
    }
  });

  test('5. Mark-default control stays disabled when there is nothing overdue', async ({ browser }) => {
    const w = await fundedWallet(SOL(0.003), 0n);
    const s = await openSession(browser, w);
    const { page } = s;
    try {
      await page.goto('/#book');
      const panel = page.locator('.mark-default');
      const button = panel.getByRole('button', { name: 'Mark as defaulted' });
      await expect(panel.getByText('Connect a wallet to send this.')).toBeVisible();
      await expect(button).toBeDisabled();

      await connectWallet(page, w);
      await expect(button).toBeDisabled(); // connected but no borrower typed

      await panel.getByLabel('Borrower wallet').fill('not-a-wallet');
      await expect(panel).toContainText('That is not a valid wallet address.');
      await expect(button).toBeDisabled();

      await panel.getByLabel('Borrower wallet').fill(w.address); // this wallet has no line
      await expect(panel.locator('.notice')).toContainText('This wallet has no credit line here.');
      await expect(button).toBeDisabled();

      const borrowed = loadState().borrow?.wallet;
      expect(borrowed, 'flow 1 has not run').toBeTruthy();
      await panel.getByLabel('Borrower wallet').fill(borrowed!); // a line that exists and was repaid in full
      await expect(panel.locator('.notice')).toContainText('Not overdue');
      await expect(panel.locator('.notice')).toContainText('Nothing is borrowed right now.');
      await expect(button).toBeDisabled();
      expect(w.signCount).toBe(0);
      // (the "borrowed but not yet due, and a forced click is refused by the program" case runs inside flow 1)
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
void USDC_UNIT;
void ENCLAVE_URL;
void ({} as TestWallet);
