# Notch for Android (free, sideload only)

`notch.apk` in this folder is the signed release build. No Play Store, no dApp Store, no paid account. **Devnet only: test money.**
The APK is not committed; build it with the command below.

## Install on a phone

1. Copy `notch.apk` to the phone (cable, or send it to yourself).
2. Open it. When Android asks, allow "install unknown apps" for the app you opened it from.
3. Install a wallet (Phantom or Solflare) and switch it to **devnet**.
4. Open Notch, tap **Get started**, then **Wallet app on this phone**.

Needs Android 8 (API 26) or newer and an up-to-date Android System WebView.

## Build

```sh
cd app
pnpm install
pnpm android:apk            # -> android-release/notch.apk
```

Needs: Android SDK in `~/Android/Sdk` (or `ANDROID_HOME`) with `platforms;android-36` and `build-tools;36.0.0`,
and JDK 21 (`mise install java@temurin-21`, or set `NOTCH_JAVA_HOME`). `app/.env.local` supplies the other `VITE_*` values.

The underwriter URL is baked in at build time. The default is the one on Phala Cloud:
`https://0015f90bd03804232678c956ce789b09384f4b1d-8787.dstack-pha1-prod9.phala.network`.
Override it with `VITE_ENCLAVE_URL=https://...`.

## Signing key

- Key: `~/.config/notch/android-release.jks`. Password: `~/.config/notch/android-release.env`. Both mode 600, outside the repo.
- The build script makes them the first time and never prints the password.
- **Back both up.** Android only installs an update over the app if it is signed with the same key.
- Raise `versionCode` in `android/app/build.gradle` before sharing an update.

## Why Capacitor and not a Trusted Web Activity (TWA)

- A TWA shows a **hosted** website. Notch has no permanent free host; a temporary tunnel URL would break the app when it closes.
  Capacitor puts the built `dist/` inside the APK, so the screens work without any host.
- A TWA needs `assetlinks.json` on that host to hide the browser bar. Capacitor needs nothing on a server.
- The cost: a WebView is not Chrome, so wallet connection needed the two points below, and web updates need a new APK.

## How wallets connect

1. **Mobile Wallet Adapter (main way).** `@solana-mobile/wallet-standard-mobile`, the same library as the web app.
   It refuses ordinary WebViews unless the user agent says `Solana Mobile Web Shell`, which `capacitor.config.json` adds.
   The wallet opens from a `solana-wallet:` link and talks back over `ws://localhost`
   (the only cleartext traffic allowed: `res/xml/network_security_config.xml`). No extra Capacitor plugin is needed.
   The library gives up unless the window blurs when the wallet opens, and the WebView never sends that, so
   `src/native.ts` sends it when Android pauses the app.
2. **Phantom deeplinks (fallback, "Phantom app" in the sign-in list).** Phantom answers to
   `app.notchbureau.mobile://return/`, and `src/native.ts` reloads the page with that answer.

The page inside the app is served as `https://notch.internal` (`server.hostname` in `capacitor.config.json`), not Capacitor's
default `https://localhost`: the public devnet RPC answers 403 to the `localhost` origin, so nothing would load.
`.internal` is reserved for private use, so the name can never belong to anyone's website.

Not offered inside the app: "open in the wallet's browser" (it cannot open a page that lives inside the APK), Google sign-in
(Google refuses WebViews) and WalletConnect.

## Known limits

- The Phala underwriter is a **demo**: it only accepts the sample statements ("Send a sample statement"), not real mail.
- It has **no faucet**. Get devnet SOL at <https://faucet.solana.com>. Test USDC has to be sent by the project owner,
  or build against an underwriter that has a faucet.
- The Phantom deeplink fallback has unit tests but has **not** been tried with the real Phantom app.
- Wallets see the app's address as `https://notch.internal`, so they cannot verify its identity.
- The app was tested on an emulator with Solana Mobile's test wallet (fakewallet), not on a physical phone.

## Android tooling on the build machine

`avdmanager list avd` failed because the SDK tools were not on `PATH` (symlinks now in `~/.local/bin`). The AVD also lives
in `~/.config/.android/avd` while the emulator looks in `~/.android/avd`, fixed with a symlink for `notch_pixel.ini`.

Screenshots from the emulator test: [`screens/`](screens/).
