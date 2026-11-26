import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // WalletConnect loads on demand; pre-bundle it so the dev server never reloads the page on the first tap.
  optimizeDeps: { include: ['@reown/appkit/core', '@reown/appkit/networks', '@walletconnect/universal-provider'] },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
