#!/usr/bin/env bash
# Plays the external system of Cosmic Python chapter 11: posts one order to
# the Stock app's webhook (webhook-routes/orders.yaml), signed with the shared
# secret. Swamp runs @puddleworks/place-order for it.
#
# Usage: ORDERS_WEBHOOK_SECRET=<secret> scripts/send_order.sh <serve-url> <orderid> <sku> <qty>
# e.g.   scripts/send_order.sh https://stock--mellens.onamp.dev o-42 RED-CHAIR 2
set -euo pipefail
: "${ORDERS_WEBHOOK_SECRET:?set ORDERS_WEBHOOK_SECRET to the webhook secret}"
[ $# -eq 4 ] || { sed -n 6,7p "$0" >&2; exit 2; }
url="${1%/}/hooks/orders"
body="$(printf '{"orderid":"%s","sku":"%s","qty":%s}' "$2" "$3" "$4")"
sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$ORDERS_WEBHOOK_SECRET" | sed 's/^.*= //')"
curl -sS -X POST "$url" \
  -H 'Content-Type: application/json' \
  -H "X-Puddleworks-Signature: sha256=$sig" \
  --data-binary "$body" \
  -w '\nHTTP %{http_code}\n'
