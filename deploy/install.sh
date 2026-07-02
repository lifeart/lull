#!/usr/bin/env bash
# One-shot local hub bring-up for development / a simple always-on box (no Docker).
# For the full TLS deployment use docker-compose.yml with your domain + DNS token.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing hub dependencies (ws only)…"
npm install --omit=dev

echo "==> Baking seamless noise loops…"
npm run bake

echo "==> Done. Start the hub with:"
echo "      npm start"
echo
echo "   Then on THIS machine open http://localhost:8080/"
echo "   To reach a real iPhone/iPad you need HTTPS — see deploy/docker-compose.yml + deploy/Caddyfile."
