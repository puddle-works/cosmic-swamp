/**
 * View logic for the stock app, kept apart from React so `bun test` covers it.
 * The app reads data written by the `stock` behavior; records written by an
 * older version of the behavior may have another shape, so parse defensively.
 */

export const BEHAVIOR = "stock";
export const BEHAVIOR_TYPE = "@puddleworks/allocation";

export const PRODUCTS_QUERY = `modelName == "${BEHAVIOR}" && specName == "product"`;
export const ALLOCATIONS_QUERY = `modelName == "${BEHAVIOR}" && specName == "allocation"`;

export interface BatchRow {
  sku: string;
  reference: string;
  eta: string | null;
  purchased: number;
  allocated: number;
  available: number;
}

export interface AllocationRow {
  orderid: string;
  sku: string;
  qty: number;
  /** null: the line was released (deallocated, or its batch shrank) and is not allocated now. */
  batchref: string | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const record = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** Batches across every product, warehouse stock first, then by ETA, as allocation prefers them. */
export function batchRows(contents: unknown[]): BatchRow[] {
  const rows: BatchRow[] = [];
  for (const content of contents) {
    const product = record(content);
    const sku = str(product?.sku);
    if (!sku || !Array.isArray(product?.batches)) continue;
    for (const raw of product.batches) {
      const b = record(raw);
      const reference = str(b?.reference);
      const purchased = num(b?.purchasedQuantity);
      const available = num(b?.availableQuantity);
      if (!b || !reference || purchased === null || available === null) continue;
      rows.push({
        sku,
        reference,
        eta: str(b.eta),
        purchased,
        allocated: num(b.allocatedQuantity) ?? purchased - available,
        available,
      });
    }
  }
  return rows.sort((a, b) =>
    a.sku.localeCompare(b.sku) ||
    (a.eta === b.eta ? 0 : a.eta === null ? -1 : b.eta === null ? 1 : a.eta.localeCompare(b.eta))
  );
}

export function allocationRows(contents: unknown[]): AllocationRow[] {
  return contents.flatMap((content) => {
    const a = record(content);
    const orderid = str(a?.orderid), sku = str(a?.sku), batchref = a?.batchref === null ? null : str(a?.batchref), qty = num(a?.qty);
    const valid = orderid && sku && qty !== null && (batchref !== null || a?.batchref === null);
    return valid ? [{ orderid, sku, qty, batchref }] : [];
  }).sort((x, y) => x.sku.localeCompare(y.sku) || x.orderid.localeCompare(y.orderid));
}

export interface StockTotal {
  sku: string;
  available: number;
}

export function totalsBySku(rows: BatchRow[]): StockTotal[] {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.sku, (totals.get(r.sku) ?? 0) + r.available);
  return [...totals].map(([sku, available]) => ({ sku, available }));
}

/** Form values arrive as strings; returns method inputs, or an error for the form. */
export function batchInputs(form: { ref: string; sku: string; qty: string; eta: string }):
  | { inputs: Record<string, unknown> }
  | { error: string } {
  const qty = Number(form.qty);
  if (!form.ref.trim() || !form.sku.trim()) return { error: "Reference and SKU are required" };
  if (!Number.isInteger(qty) || qty < 1) return { error: "Quantity must be a whole number above 0" };
  const inputs: Record<string, unknown> = { ref: form.ref.trim(), sku: form.sku.trim(), qty };
  if (form.eta.trim()) inputs.eta = form.eta.trim();
  return { inputs };
}

export function orderInputs(form: { orderid: string; sku: string; qty: string }):
  | { inputs: { orderid: string; sku: string; qty: number } }
  | { error: string } {
  const qty = Number(form.qty);
  if (!form.orderid.trim() || !form.sku.trim()) return { error: "Order and SKU are required" };
  if (!Number.isInteger(qty) || qty < 1) return { error: "Quantity must be a whole number above 0" };
  return { inputs: { orderid: form.orderid.trim(), sku: form.sku.trim(), qty } };
}

/** A batch's new quantity may be 0 (none of it usable), unlike a new batch's. */
export function quantityInputs(form: { ref: string; sku: string; qty: string }):
  | { inputs: { ref: string; sku: string; qty: number } }
  | { error: string } {
  const qty = Number(form.qty);
  if (!form.ref.trim() || !form.sku.trim()) return { error: "Batch and SKU are required" };
  if (form.qty.trim() === "" || !Number.isInteger(qty) || qty < 0) {
    return { error: "Quantity must be a whole number, 0 or more" };
  }
  return { inputs: { ref: form.ref.trim(), sku: form.sku.trim(), qty } };
}

/**
 * What an `allocate` run did, read from the data it wrote: the allocation
 * record, and an OutOfStock event when no batch had room. Allocation no
 * longer fails for lack of stock (ADR 0007), so the app must look.
 */
export function allocateOutcome(
  orderid: string,
  artifacts: ReadonlyArray<{ name: string; attributes?: Record<string, unknown> }>,
): { kind: "ok" | "error"; text: string } {
  const allocation = artifacts.find((a) => a.name.startsWith("allocation-"))?.attributes;
  const batchref = str(allocation?.batchref);
  if (batchref) return { kind: "ok", text: `Allocated order ${orderid} to ${batchref}` };
  const event = artifacts.map((a) => a.attributes).find((a) => a?.type === "OutOfStock");
  if (event) {
    return {
      kind: "error",
      text: `Insufficient stock for SKU ${str(event.sku)}: requested ${num(event.qty)}, largest available in any batch is ${num(event.available)}. Order ${orderid} is unallocated.`,
    };
  }
  return { kind: "error", text: `Order ${orderid} is not allocated` };
}
