import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  Batch,
  DuplicateBatch,
  outOfStockMessage,
  Product,
  SkuMismatch,
  UnknownBatch,
} from "./domain.ts";

const TODAY = "2026-12-01";
const TOMORROW = "2026-12-02";
const NEXT_MONTH = "2027-01-02";

const line = (orderid: string, sku: string, qty: number) => ({
  orderid,
  sku,
  qty,
});

// --- Batch -----------------------------------------------------------------

Deno.test("allocating a line reduces the batch's available quantity", () => {
  const batch = new Batch("b-1", "OAK-STOOL", 20);
  batch.allocate(line("o-1", "OAK-STOOL", 2));
  assertEquals(batch.availableQuantity, 18);
  assertEquals(batch.allocatedQuantity, 2);
});

Deno.test("a batch can take a line smaller than or equal to its stock, not a larger one", () => {
  const batch = new Batch("b-1", "OAK-STOOL", 5);
  assertEquals(batch.canAllocate(line("o-1", "OAK-STOOL", 4)), true);
  assertEquals(batch.canAllocate(line("o-1", "OAK-STOOL", 5)), true);
  assertEquals(batch.canAllocate(line("o-1", "OAK-STOOL", 6)), false);
});

Deno.test("a batch refuses lines for another SKU", () => {
  const batch = new Batch("b-1", "OAK-STOOL", 100);
  assertEquals(batch.canAllocate(line("o-1", "PINE-STOOL", 1)), false);
});

Deno.test("allocating the same line twice counts it once", () => {
  const batch = new Batch("b-1", "BRASS-LAMP", 10);
  batch.allocate(line("o-1", "BRASS-LAMP", 3));
  batch.allocate(line("o-1", "BRASS-LAMP", 3));
  assertEquals(batch.availableQuantity, 7);
});

Deno.test("deallocating releases only lines the batch holds", () => {
  const batch = new Batch("b-1", "BRASS-LAMP", 10);
  batch.deallocate(line("o-9", "BRASS-LAMP", 3));
  assertEquals(batch.availableQuantity, 10);
  batch.allocate(line("o-1", "BRASS-LAMP", 3));
  batch.deallocate(line("o-1", "BRASS-LAMP", 3));
  assertEquals(batch.availableQuantity, 10);
});

Deno.test("batch state round-trips through its stored form", () => {
  const batch = new Batch("b-1", "BRASS-LAMP", 10, TOMORROW);
  batch.allocate(line("o-1", "BRASS-LAMP", 4));
  const copy = Batch.fromState(JSON.parse(JSON.stringify(batch.toState())));
  assertEquals(copy.toState(), batch.toState());
  assertEquals(copy.availableQuantity, 6);
});

// --- Product aggregate ------------------------------------------------------

Deno.test("warehouse stock is preferred to a shipment, even one listed first", () => {
  const product = new Product("WOOL-RUG");
  const shipment = product.addBatch("ship-1", 50, TODAY);
  const warehouse = product.addBatch("wh-1", 50, null);

  assertEquals(product.allocate(line("o-1", "WOOL-RUG", 5)), "wh-1");
  assertEquals(warehouse.availableQuantity, 45);
  assertEquals(shipment.availableQuantity, 50);
});

Deno.test("among shipments the earliest ETA is used, whatever the order batches were added", () => {
  const product = new Product("WOOL-RUG");
  product.addBatch("late", 50, NEXT_MONTH);
  product.addBatch("soon", 50, TODAY);
  product.addBatch("middle", 50, TOMORROW);

  assertEquals(product.allocate(line("o-1", "WOOL-RUG", 5)), "soon");
  const available = Object.fromEntries(
    product.batches.map((b) => [b.reference, b.availableQuantity]),
  );
  assertEquals(available, { late: 50, soon: 45, middle: 50 });
});

Deno.test("a line that does not fit the preferred batch goes to the next one that can take it", () => {
  const product = new Product("WOOL-RUG");
  product.addBatch("wh-small", 3, null);
  product.addBatch("ship-big", 30, TOMORROW);

  assertEquals(product.allocate(line("o-1", "WOOL-RUG", 10)), "ship-big");
});

Deno.test("lines are never split across batches: total stock is not enough on its own", () => {
  const product = new Product("WOOL-RUG");
  product.addBatch("a", 6, null);
  product.addBatch("b", 6, TODAY);

  assertEquals(product.allocate(line("o-1", "WOOL-RUG", 10)), null);
  assertEquals(product.events, [
    { type: "OutOfStock", ...line("o-1", "WOOL-RUG", 10), available: 6 },
  ]);
  assertEquals(product.availableQuantity, 12);
});

Deno.test("out of stock once the only batch is used up, naming the SKU", () => {
  const product = new Product("TIN-KETTLE");
  product.addBatch("b-1", 4, TODAY);
  product.allocate(line("o-1", "TIN-KETTLE", 4));

  assertEquals(product.allocate(line("o-2", "TIN-KETTLE", 1)), null);
  const event = product.events.at(-1)!;
  assertEquals(event.type, "OutOfStock");
  assertEquals(
    outOfStockMessage({ ...line("o-2", "TIN-KETTLE", 1), available: 0 }),
    "Insufficient stock for SKU TIN-KETTLE: requested 1, largest available in any batch is 0",
  );
});

Deno.test("a product with no batches is out of stock", () => {
  const product = new Product("TIN-KETTLE");
  assertEquals(product.allocate(line("o-1", "TIN-KETTLE", 1)), null);
  assertEquals(product.events.map((e) => e.type), ["OutOfStock"]);
});

Deno.test("re-allocating an allocated line returns its batch and takes no more stock", () => {
  const product = new Product("TIN-KETTLE");
  product.addBatch("wh", 1, null);
  product.addBatch("ship", 10, TODAY);
  assertEquals(product.allocate(line("o-1", "TIN-KETTLE", 1)), "wh");
  assertEquals(product.allocate(line("o-1", "TIN-KETTLE", 1)), "wh");
  assertEquals(product.availableQuantity, 10);
});

Deno.test("a product refuses lines and duplicate batches that are not its own", () => {
  const product = new Product("TIN-KETTLE");
  product.addBatch("b-1", 4);
  assertThrows(
    () => product.allocate(line("o-1", "COPPER-KETTLE", 1)),
    SkuMismatch,
  );
  assertThrows(() => product.addBatch("b-1", 9), DuplicateBatch);
});

Deno.test("product state round-trips with its allocations", () => {
  const product = new Product("TIN-KETTLE");
  product.addBatch("b-1", 4, TOMORROW);
  product.allocate(line("o-1", "TIN-KETTLE", 3));
  const copy = Product.fromState(JSON.parse(JSON.stringify(product.toState())));
  assertEquals(copy.toState(), product.toState());
  assertEquals(copy.allocate(line("o-2", "TIN-KETTLE", 2)), null);
});

// --- Deallocation and batch quantity changes (chapter 9) -------------------

Deno.test("deallocating returns the line's batch and frees its stock; an unallocated line gives null", () => {
  const product = new Product("BRASS-BELL");
  product.addBatch("wh", 5, null);
  product.allocate(line("o-1", "BRASS-BELL", 2));

  assertEquals(product.deallocate(line("o-1", "BRASS-BELL", 2)), "wh");
  assertEquals(product.availableQuantity, 5);
  assertEquals(product.deallocate(line("o-1", "BRASS-BELL", 2)), null);
});

Deno.test("shrinking a batch releases its newest lines until it fits, and reallocates them oldest first", () => {
  const product = new Product("BRASS-BELL");
  product.addBatch("wh", 10, null);
  product.addBatch("ship", 10, TODAY);
  product.allocate(line("o-1", "BRASS-BELL", 3));
  product.allocate(line("o-2", "BRASS-BELL", 4));
  product.allocate(line("o-3", "BRASS-BELL", 2));

  // 6 cannot cover 3 + 4 + 2. Releasing o-3, then o-2, is enough (3 left).
  // o-2 (4) no longer fits the warehouse and goes to the shipment; o-3 (2)
  // fits what is left of the warehouse, which is still preferred.
  const moved = product.changeBatchQuantity("wh", 6);

  assertEquals(moved, [
    { line: line("o-2", "BRASS-BELL", 4), batchref: "ship" },
    { line: line("o-3", "BRASS-BELL", 2), batchref: "wh" },
  ]);
  const [wh, ship] = product.batches;
  assertEquals(wh.allocations.map((l) => l.orderid), ["o-1", "o-3"]);
  assertEquals([wh.purchasedQuantity, wh.availableQuantity], [6, 1]);
  assertEquals(ship.allocations.map((l) => l.orderid), ["o-2"]);
});

Deno.test("a line no batch has room for stays unallocated, and the new quantity still applies", () => {
  const product = new Product("BRASS-BELL");
  product.addBatch("wh", 5, null);
  product.allocate(line("o-1", "BRASS-BELL", 5));

  const moved = product.changeBatchQuantity("wh", 2);

  assertEquals(moved, [{ line: line("o-1", "BRASS-BELL", 5), batchref: null }]);
  assertEquals(product.batches[0].purchasedQuantity, 2);
  assertEquals(product.availableQuantity, 2);
  assertEquals(product.allocationOf(line("o-1", "BRASS-BELL", 5)), undefined);
});

Deno.test("growing a batch moves no lines; an unknown batch is refused", () => {
  const product = new Product("BRASS-BELL");
  product.addBatch("wh", 5, null);
  product.allocate(line("o-1", "BRASS-BELL", 5));

  assertEquals(product.changeBatchQuantity("wh", 8), []);
  assertEquals(product.availableQuantity, 3);
  assertThrows(() => product.changeBatchQuantity("nope", 1), UnknownBatch);
});
