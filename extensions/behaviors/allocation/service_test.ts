import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { OutOfStock, type ProductState } from "./domain.ts";
import { InMemoryStore } from "./memory_store.ts";
import {
  addBatch,
  allocate,
  ConcurrentUpdate,
  ConflictingOrderLine,
  createOrderLine,
  UnknownOrderLine,
  UnknownSku,
  type Versioned,
} from "./service.ts";

Deno.test("adding a batch creates the product, and later batches join it", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await addBatch(
    { ref: "b-2", sku: "FELT-HAT", qty: 5, eta: "2027-02-01" },
    store,
  );

  const product = store.products.get("FELT-HAT")!;
  assertEquals(product.version, 2);
  assertEquals(
    product.value.batches.map((b) => [b.reference, b.purchasedQuantity, b.eta]),
    [
      ["b-1", 10, null],
      ["b-2", 5, "2027-02-01"],
    ],
  );
});

Deno.test("allocating a recorded line returns and stores the allocation", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 4 }, store);

  const view = await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);

  assertEquals(view, {
    orderid: "o-1",
    sku: "FELT-HAT",
    qty: 4,
    batchref: "b-1",
  });
  assertEquals(store.allocations.get("o-1/FELT-HAT"), view);
  assertEquals(store.products.get("FELT-HAT")!.value.batches[0].allocations, [
    { orderid: "o-1", sku: "FELT-HAT", qty: 4 },
  ]);
});

Deno.test("an unknown SKU is refused when recording a line", async () => {
  const store = new InMemoryStore();
  await assertRejects(
    () => createOrderLine({ orderid: "o-1", sku: "NOPE", qty: 1 }, store),
    UnknownSku,
    "NOPE",
  );
  assertEquals(store.lines.size, 0);
});

Deno.test("allocation needs a recorded order line", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await assertRejects(
    () => allocate({ orderid: "o-1", sku: "FELT-HAT" }, store),
    UnknownOrderLine,
  );
});

Deno.test("recording a line twice is idempotent, but a different quantity is refused", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 2 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 2 }, store);
  await assertRejects(
    () => createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 3 }, store),
    ConflictingOrderLine,
  );
  assertEquals(store.lines.size, 1);
});

Deno.test("out of stock saves nothing", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 3 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 4 }, store);
  const savesBefore = store.productSaves;

  await assertRejects(
    () => allocate({ orderid: "o-1", sku: "FELT-HAT" }, store),
    OutOfStock,
  );
  assertEquals(store.productSaves, savesBefore);
  assertEquals(store.allocations.size, 0);
});

Deno.test("allocating an allocated line again does not save the product again", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 4 }, store);
  await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);
  const versionAfterFirst = store.products.get("FELT-HAT")!.version;

  const again = await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);
  assertEquals(again.batchref, "b-1");
  assertEquals(store.products.get("FELT-HAT")!.version, versionAfterFirst);
});

/** A store whose next `holdReads` product reads wait for each other, forcing a read-read-write-write interleaving. */
class InterleavingStore extends InMemoryStore {
  holdReads = 0;
  #waiting: Array<() => void> = [];
  override async getProduct(
    sku: string,
  ): Promise<Versioned<ProductState> | null> {
    const read = await super.getProduct(sku);
    if (this.holdReads > 0) {
      this.holdReads--;
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
        if (this.holdReads === 0) this.#waiting.forEach((r) => r());
      });
    }
    return read;
  }
}

Deno.test("two allocations that read the same product version: one wins, the other is refused", async () => {
  const store = new InterleavingStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 6 }, store);
  await createOrderLine({ orderid: "o-2", sku: "FELT-HAT", qty: 6 }, store);
  // Both commands now read version 1 before either saves. Only 10 are in
  // stock, so letting both through would over-allocate the batch by 2.
  store.holdReads = 2;

  const results = await Promise.allSettled([
    allocate({ orderid: "o-1", sku: "FELT-HAT" }, store),
    allocate({ orderid: "o-2", sku: "FELT-HAT" }, store),
  ]);

  assertEquals(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((r) =>
    r.status === "rejected"
  ) as PromiseRejectedResult;
  assertEquals(rejected.reason instanceof ConcurrentUpdate, true);
  const batch = store.products.get("FELT-HAT")!.value.batches[0];
  assertEquals(batch.allocations.length, 1);
  assertEquals(store.allocations.size, 1);
});
