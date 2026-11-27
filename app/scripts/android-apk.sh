#!/usr/bin/env bash
# Build the signed, sideloadable Android app: android-release/notch.apk
#   pnpm android:apk                                   (uses the underwriter on Phala Cloud)
#   VITE_ENCLAVE_URL=https://... pnpm android:apk      (any other public underwriter)
# The other VITE_* values are read by Vite from .env.local. Free: no store, no accounts. See android-release/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

VITE_ENCLAVE_URL="${VITE_ENCLAVE_URL:-https://0015f90bd03804232678c956ce789b09384f4b1d-8787.dstack-pha1-prod9.phala.network}"
[[ $VITE_ENCLAVE_URL == https://* ]] || { echo "VITE_ENCLAVE_URL must be https:// (a phone cannot reach your localhost)" >&2; exit 1; }
export VITE_ENCLAVE_URL
# Google sign-in refuses WebViews, and WalletConnect is not needed where Mobile Wallet Adapter works.
export VITE_POLLAR=off VITE_WC_PROJECT_ID=

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${NOTCH_JAVA_HOME:-$(mise where java@temurin-21)}" # Capacitor 8 needs JDK 21
export PATH="$JAVA_HOME/bin:$PATH"

# Release key: made once, kept outside the repository, password never printed. Keep a backup: an update signed with
# another key cannot be installed over the app.
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/notch"
KS="$CFG/android-release.jks"
KSENV="$CFG/android-release.env"
if [[ ! -e $KS ]]; then
  (
    umask 077
    mkdir -p "$CFG"
    [[ -e $KSENV ]] || printf 'NOTCH_KEYSTORE_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$KSENV"
    set -a; . "$KSENV"; set +a
    keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias notch -keyalg RSA -keysize 4096 -validity 10000 \
      -dname 'CN=Notch, OU=Hackathon, O=Notch' -storepass:env NOTCH_KEYSTORE_PASSWORD -keypass:env NOTCH_KEYSTORE_PASSWORD
  )
  echo "Made a new release key: $KS"
fi
set -a; . "$KSENV"; set +a
export NOTCH_KEYSTORE="$KS"

pnpm exec tsc --noEmit -p .
pnpm exec vite build
pnpm exec cap sync android
(cd android && ./gradlew --no-daemon --console=plain assembleRelease)

mkdir -p android-release
cp android/app/build/outputs/apk/release/app-release.apk android-release/notch.apk
"$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner" verify android-release/notch.apk
ls -lh android-release/notch.apk
