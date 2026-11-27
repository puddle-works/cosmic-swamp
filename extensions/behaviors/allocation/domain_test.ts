import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  Batch,
  DuplicateBatch,
  OutOfStock,
  Product,
  SkuMismatch,
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

  const error = assertThrows(
    () => product.allocate(line("o-1", "WOOL-RUG", 10)),
    OutOfStock,
  );
  assertEquals([error.sku, error.requested, error.available], [
    "WOOL-RUG",
    10,
    6,
  ]);
  assertEquals(product.availableQuantity, 12);
});

Deno.test("out of stock once the only batch is used up, naming the SKU", () => {
  const product = new Product("TIN-KETTLE");
  product.addBatch("b-1", 4, TODAY);
  product.allocate(line("o-1", "TIN-KETTLE", 4));

  assertThrows(
    () => product.allocate(line("o-2", "TIN-KETTLE", 1)),
    OutOfStock,
    "TIN-KETTLE",
  );
});

Deno.test("a product with no batches is out of stock", () => {
  assertThrows(
    () => new Product("TIN-KETTLE").allocate(line("o-1", "TIN-KETTLE", 1)),
    OutOfStock,
  );
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
  assertThrows(() => copy.allocate(line("o-2", "TIN-KETTLE", 2)), OutOfStock);
});
