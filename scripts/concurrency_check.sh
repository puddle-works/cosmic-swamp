#!/usr/bin/env bash
# Races N separate `swamp behavior run ... allocate` processes for one SKU.
# Stock is 10; each line wants 3, so exactly 3 allocations may succeed.
set -euo pipefail
SKU="RACE-$(date +%s)"
N="${1:-10}"
swamp behavior run stock add_batch --input ref=b-1 --input "sku=$SKU" --input qty=10 --json >/dev/null
for i in $(seq 1 "$N"); do
  swamp behavior run stock create_order_line --input "orderid=r-$i" --input "sku=$SKU" --input qty=3 --json >/dev/null
done
pids=()
for i in $(seq 1 "$N"); do
  swamp behavior run stock allocate --input "orderid=r-$i" --input "sku=$SKU" --json >"/tmp/race-$i.out" 2>&1 & pids+=($!)
done
ok=0; refused=0
for i in "${!pids[@]}"; do
  if wait "${pids[$i]}"; then ok=$((ok+1)); else refused=$((refused+1)); fi
done
echo "succeeded=$ok refused=$refused"
cat /tmp/race-*.out | jq -r 'select(.error) | .error' | sed 's/requested.*//' | sort | uniq -c
swamp data query "behavior(\"stock\") && name == \"product-$SKU\"" --select attributes --json \
  | jq -c '.results[0] | {available: .availableQuantity, allocated: [.batches[].allocations[].orderid]}'
swamp data query "behavior(\"stock\") && specName == \"allocation\" && attributes.sku == \"$SKU\"" --json | jq '.total' | sed 's/^/allocation records=/'
rm -f /tmp/race-*.out
