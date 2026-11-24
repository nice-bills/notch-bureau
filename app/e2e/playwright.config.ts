import { defineConfig } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // app/e2e
const app = path.resolve(here, '..'); // app/
const chromium = process.env.E2E_CHROMIUM; // optional path to a system Chromium if `playwright install chromium` was not run

export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.ts',
  outputDir: path.join(here, 'test-results'),
  // One worker, in order: the flows share one devnet pool and the loan-book flow reads what flows 1 and 2 left.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 45_000 },
  reporter: [['list'], ['html', { outputFolder: path.join(here, 'report'), open: 'never' }]],
  globalSetup: path.join(here, 'global-setup.ts'),
  globalTeardown: path.join(here, 'global-teardown.ts'),
  use: {
    headless: true,
    baseURL: process.env.E2E_APP_URL || 'http://localhost:5173',
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
  // Start the sealed computer (demo underwriter) and the Vite dev server unless they are already running.
  webServer: [
    {
      command: 'node scripts/demo-enclave.mjs',
      cwd: app,
      // The demo enclave refuses to start without a secret pepper (the phone-number hash on chain would be brute-forceable).
      env: { NOTCH_KEY_FILE: path.resolve(app, '../.underwriter-key.json'), NOTCH_ID_PEPPER: process.env.NOTCH_ID_PEPPER || crypto.randomBytes(32).toString('hex') },
      url: 'http://localhost:8787/attestation',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      cwd: app,
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
