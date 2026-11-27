#!/usr/bin/env bash
# End-to-end races against the real datastore, each command its own process.
#
# 1. allocate vs allocate: N lines of 3 race for one batch of 10, so exactly
#    3 may be allocated (the rest run out of stock, which is an event, not
#    a failure: ADR 0007).
# 2. change_batch_quantity vs allocate: N lines of 3 race for a warehouse
#    batch of 10 and a shipment of 6 while both batches are shrunk (to 4 and
#    3). Whatever the order, no batch may end over-allocated, the shrinks must
#    both stick, and every allocation record must name the batch that really
#    holds its line (or null for a released line).
#
# Exits non-zero when an invariant fails. Usage: scripts/concurrency_check.sh [N]
set -euo pipefail
N="${1:-10}"
STAMP="$(date +%s)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
failed=0

run() { swamp behavior run stock "$1" "${@:2}" --json; }

product() {
  swamp data query "behavior(\"stock\") && name == \"product-$1\"" --select attributes --json | jq -c '.results[0]'
}

allocations() {
  swamp data query "behavior(\"stock\") && specName == \"allocation\" && attributes.sku == \"$1\"" \
    --select attributes --json | jq -c '[.results[]]'
}

check() { # name, jq filter over {product, allocations} that is true when the invariant holds
  if jq -e "$2" <<<"{\"product\": $P, \"allocations\": $A}" >/dev/null; then
    echo "  ok: $1"
  else
    echo "  FAILED: $1"; failed=1
  fi
}

lines() { # sku: records N order lines of 3
  for i in $(seq 1 "$N"); do
    run create_order_line --input "orderid=r-$i" --input "sku=$1" --input qty=3 >/dev/null
  done
}

wait_all() { # sets ok/refused; runs in this shell, since wait only sees its own children
  ok=0; refused=0
  for pid in "$@"; do if wait "$pid"; then ok=$((ok+1)); else refused=$((refused+1)); fi; done
}

# Invariants shared by both races.
no_over_allocation='all(.product.batches[]; .allocatedQuantity <= .purchasedQuantity)'
records_match='
  ([.product.batches[] | .reference as $b | .allocations[] | {key: .orderid, value: $b}] | from_entries) as $held
  | all(.allocations[]; .batchref == $held[.orderid])
  and ([.product.batches[].allocations[].orderid] | length) == ([.product.batches[].allocations[].orderid] | unique | length)'

echo "== allocate vs allocate ($N processes, batch of 10, lines of 3)"
SKU="RACE-$STAMP"
run add_batch --input ref=b-1 --input "sku=$SKU" --input qty=10 >/dev/null
lines "$SKU"
pids=()
for i in $(seq 1 "$N"); do
  run allocate --input "orderid=r-$i" --input "sku=$SKU" >"$OUT/a-$i.out" 2>&1 & pids+=($!)
done
wait_all "${pids[@]}"
echo "  runs succeeded=$ok failed=$refused"
P="$(product "$SKU")"; A="$(allocations "$SKU")"
check "exactly 3 allocations" '[.product.batches[].allocations[]] | length == 3'
check "no batch over-allocated" "$no_over_allocation"
check "allocation records match the product" "$records_match"

echo "== change_batch_quantity vs allocate ($N allocations, 2 shrinks)"
SKU="QTYRACE-$STAMP"
run add_batch --input ref=wh --input "sku=$SKU" --input qty=10 >/dev/null
run add_batch --input ref=ship --input "sku=$SKU" --input qty=6 --input eta=2027-03-01 >/dev/null
lines "$SKU"
pids=()
for i in $(seq 1 "$N"); do
  run allocate --input "orderid=r-$i" --input "sku=$SKU" >"$OUT/q-$i.out" 2>&1 & pids+=($!)
  # The shrinks start among the allocations, so some lines land before and some after.
  if [ "$i" -eq 2 ]; then
    run change_batch_quantity --input ref=wh --input "sku=$SKU" --input qty=4 >"$OUT/c-wh.out" 2>&1 & pids+=($!)
  fi
  if [ "$i" -eq 4 ]; then
    run change_batch_quantity --input ref=ship --input "sku=$SKU" --input qty=3 >"$OUT/c-ship.out" 2>&1 & pids+=($!)
  fi
done
wait_all "${pids[@]}"
echo "  runs succeeded=$ok failed=$refused (the 2 shrinks are among them)"
P="$(product "$SKU")"; A="$(allocations "$SKU")"
jq -c '{batches: [.batches[] | {ref: .reference, purchased: .purchasedQuantity, lines: [.allocations[].orderid]}]}' <<<"$P" | sed 's/^/  /'
check "both shrinks stuck (wh 4, ship 3)" \
  '[.product.batches[] | [.reference, .purchasedQuantity]] == [["wh", 4], ["ship", 3]]'
check "no batch over-allocated" "$no_over_allocation"
check "allocation records match the product" "$records_match"

exit "$failed"
