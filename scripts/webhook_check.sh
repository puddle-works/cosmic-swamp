#!/usr/bin/env bash
# End to end over the webhook: starts its own `swamp serve` on a free loopback
# port, adds one batch, then plays the external system with send_order.sh:
#
# 1. an order the batch can take: an `allocation` record names the batch and
#    an `Allocated` event is saved;
# 2. an order for a SKU with no stock: the line stays unallocated (batchref
#    null) and an `OutOfStock` event is saved;
# 3. an order with a wrong signature: 401, and nothing is recorded.
#
# Runs against the repo's real datastore with fresh SKUs, like
# concurrency_check.sh. Exits non-zero when a check fails.
# Usage: scripts/webhook_check.sh   (WEBHOOK_CHECK_TIMEOUT=<seconds>, default 60)
set -euo pipefail
cd "$(dirname "$0")/.."
TIMEOUT="${WEBHOOK_CHECK_TIMEOUT:-60}"
STAMP="$(date +%s)"
LOG="$(mktemp)"
failed=0

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
URL="http://127.0.0.1:$PORT"
swamp serve --port "$PORT" >"$LOG" 2>&1 &
SERVE=$!
trap 'kill "$SERVE" 2>/dev/null; wait "$SERVE" 2>/dev/null; rm -f "$LOG"' EXIT

for _ in $(seq 1 "$TIMEOUT"); do
  curl -fsS "$URL/ready" >/dev/null 2>&1 && break
  kill -0 "$SERVE" 2>/dev/null || { echo "swamp serve exited:"; cat "$LOG"; exit 1; }
  sleep 1
done
curl -fsS "$URL/ready" >/dev/null || { echo "swamp serve not ready after ${TIMEOUT}s:"; cat "$LOG"; exit 1; }
echo "== swamp serve on $URL"

export ORDERS_WEBHOOK_SECRET="${ORDERS_WEBHOOK_SECRET:-$(swamp vault read-secret default orders-webhook-secret --yes)}"

allocation() { # orderid sku: the allocation record's attributes, or null
  swamp data query "behavior(\"stock\") && specName == \"allocation\" && attributes.orderid == \"$1\" && attributes.sku == \"$2\"" \
    --select attributes --json | jq -c '.results[0] // null'
}

events() { # orderid sku: the saved events for that line
  swamp data query "behavior(\"stock\") && specName == \"event\" && attributes.orderid == \"$1\" && attributes.sku == \"$2\"" \
    --select attributes --json | jq -c '[.results[]]'
}

wait_for_allocation() { # orderid sku: the webhook only queues the run, so poll
  local a
  for _ in $(seq 1 "$TIMEOUT"); do
    a="$(allocation "$1" "$2")"
    [ "$a" != null ] && { echo "$a"; return; }
    sleep 1
  done
  echo null
}

check() { # name, jq filter over the input JSON that is true when it holds, input JSON
  if jq -e "$2" <<<"$3" >/dev/null; then
    echo "  ok: $1"
  else
    echo "  FAILED: $1"; echo "    got: $3"; failed=1
  fi
}

send() { # orderid sku qty: prints the HTTP status
  scripts/send_order.sh "$URL" "$@" | sed -n 's/^HTTP //p'
}

SKU="HOOK-$STAMP"
EMPTY="HOOK-EMPTY-$STAMP"
swamp behavior run stock add_batch --input "ref=wh-$STAMP" --input "sku=$SKU" --input qty=10 --json >/dev/null
# A known SKU with no stock: its only batch is shrunk to nothing.
swamp behavior run stock add_batch --input "ref=gone-$STAMP" --input "sku=$EMPTY" --input qty=1 --json >/dev/null
swamp behavior run stock change_batch_quantity --input "ref=gone-$STAMP" --input "sku=$EMPTY" --input qty=0 --json >/dev/null

echo "== order with stock ($SKU, batch wh-$STAMP of 10, line of 3)"
check "webhook answers 200" '. == 200' "$(send "o-in-$STAMP" "$SKU" 3)"
A="$(wait_for_allocation "o-in-$STAMP" "$SKU")"
check "allocation names batch wh-$STAMP" ".batchref == \"wh-$STAMP\" and .qty == 3" "$A"
check "one Allocated event to wh-$STAMP" \
  "[.[] | select(.type == \"Allocated\")] | length == 1 and .[0].batchref == \"wh-$STAMP\"" \
  "$(events "o-in-$STAMP" "$SKU")"

echo "== order out of stock ($EMPTY, its batch shrunk to 0)"
check "webhook answers 200" '. == 200' "$(send "o-out-$STAMP" "$EMPTY" 2)"
A="$(wait_for_allocation "o-out-$STAMP" "$EMPTY")"
check "allocation is unallocated" '. != null and .batchref == null' "$A"
check "one OutOfStock event" \
  '[.[] | select(.type == "OutOfStock")] | length == 1 and .[0].qty == 2' \
  "$(events "o-out-$STAMP" "$EMPTY")"

echo "== order with a wrong signature"
check "webhook answers 401" '. == 401' \
  "$(ORDERS_WEBHOOK_SECRET=wrong send "o-bad-$STAMP" "$SKU" 1)"
# The good orders above were recorded within a few seconds; give a wrongly
# queued run the same chance before checking that nothing was recorded.
sleep 5
check "nothing recorded" '. == null' "$(allocation "o-bad-$STAMP" "$SKU")"

[ "$failed" -eq 0 ] || { echo "== swamp serve log"; tail -40 "$LOG"; }
exit "$failed"
