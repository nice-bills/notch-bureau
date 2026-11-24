#!/usr/bin/env bash
# Deploy the keeper Edge Function. Supabase's server-side bundler times out resolving npm:@solana/kit,
# so we bundle locally with esbuild (node platform), prefix Node built-ins with "node:", and upload one file.
# Needs SUPABASE_ACCESS_TOKEN in the environment and app/node_modules installed.
set -euo pipefail
REF=${1:-rtdjnqbgpqygjkjvrcsp}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
mkdir -p "$W/supabase/functions/keeper"
NODE_PATH="$ROOT/app/node_modules" npx -y esbuild@0.25.0 "$ROOT/supabase/functions/keeper/index.ts" \
  --bundle --format=esm --platform=node --target=es2022 --log-level=warning \
  --outfile="$W/supabase/functions/keeper/index.ts"
sed -i -E 's/(from |require\(|import\()"(events|crypto|buffer|stream|util|http|https|url|zlib|net|tls|os|path|fs|assert|string_decoder|querystring|punycode|child_process|worker_threads|perf_hooks)"/\1"node:\2"/g' \
  "$W/supabase/functions/keeper/index.ts"
(cd "$W" && npx -y supabase@2 functions deploy keeper --no-verify-jwt --use-api --project-ref "$REF")
rm -rf "$W"
