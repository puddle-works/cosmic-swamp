#!/usr/bin/env bash
# Runs swamp serve for the Stock app on an Amp Box (see .amp/box.yaml).
#
# The Box's URL is public, so serve uses its own token sign-in. Amp's private
# deployments cannot be used: the app's sandboxed frame loads its files without
# cookies, so a cookie sign-in in front of serve blocks every one of them.
set -euo pipefail
release="$(cd "$(dirname "$0")/.." && pwd)"
data="$AMP_DEPLOYMENT_DATA_DIRECTORY"
repo="$data/repo"
export SWAMP_HOME="$data/swamp-home"
export PATH="$release/bin:$PATH"

# The release is read-only and swamp keeps its runtime data in the repo's
# .swamp/, so serve runs from a copy in the data directory. Each start
# refreshes the code and keeps .swamp/ (stock, orders, tokens, approvals).
mkdir -p "$repo" "$SWAMP_HOME"
for item in .swamp.yaml manifest.yaml extensions models workflows vaults webhook-routes; do
  rm -rf "${repo:?}/$item"
  cp -R "$release/$item" "$repo/$item"
done
chmod -R u+w "$repo"
cd "$repo"

# Same approval as .agents/setup: exactly what app.yaml declares.
swamp app approve @puddleworks/stock --yes >/dev/null

# The shared secret for webhook-routes/orders.yaml. Made once, kept in the
# vault (.swamp/secrets); read it with
#   amp boxes exec ... --as-app '... bin/swamp vault read-secret default orders-webhook-secret --yes ...' (see README)
if ! swamp vault list-keys default --json | grep -q '"orders-webhook-secret"'; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' |
    swamp vault put default orders-webhook-secret >/dev/null
fi

# The sign-in token is named "owner". Read it with:
#   amp boxes exec <box> --deployment <name> --as-app \
#     'SWAMP_HOME="$AMP_DEPLOYMENT_DATA_DIRECTORY/swamp-home" bin/swamp access token reveal owner --yes --repo-dir "$AMP_DEPLOYMENT_DATA_DIRECTORY/repo"'
# Once it has expired, the next restart mints a new one.
tokens="$(swamp access token list --json | tr -d ' \n')"
case "$tokens" in
  *'"name":"owner","state":"active","effectiveState":"active"'*) ;;
  *'"name":"owner"'*) swamp access token rotate owner --yes >/dev/null ;;
  *) swamp access token mint owner --principal user:owner --duration 90d >/dev/null ;;
esac

host="${AMP_DEPLOYMENT_URL#https://}"
host="${host%%/*}"
# Serve refuses a non-loopback bind without TLS; the Box router is local.
exec swamp serve --dashboard --host 127.0.0.1 --port "$PORT" \
  --auth-mode token --admins user:owner --trust-proxy --trusted-hosts "$host"
