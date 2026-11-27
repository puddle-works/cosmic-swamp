import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import type { ProductState } from "./domain.ts";
import { InMemoryStore } from "./memory_store.ts";
import {
  addBatch,
  allocate,
  changeBatchQuantity,
  ConcurrentUpdate,
  ConflictingOrderLine,
  createOrderLine,
  deallocate,
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
  assertEquals(store.events, [
    {
      type: "Allocated",
      orderid: "o-1",
      sku: "FELT-HAT",
      qty: 4,
      batchref: "b-1",
    },
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

Deno.test("out of stock succeeds without touching the product: the line is unallocated and OutOfStock is saved", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 3 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 4 }, store);
  const savesBefore = store.productSaves;

  const view = await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);

  assertEquals(view.batchref, null);
  assertEquals(store.productSaves, savesBefore);
  assertEquals(store.allocations.get("o-1/FELT-HAT"), view);
  assertEquals(store.events, [
    {
      type: "OutOfStock",
      orderid: "o-1",
      sku: "FELT-HAT",
      qty: 4,
      available: 3,
    },
  ]);
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
  assertEquals(store.events.length, 1);
});

Deno.test("deallocating releases the line, records it as unallocated, and it can be allocated again", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "b-1", sku: "FELT-HAT", qty: 10 }, store);
  await createOrderLine({ orderid: "o-1", sku: "FELT-HAT", qty: 4 }, store);
  await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);

  const view = await deallocate({ orderid: "o-1", sku: "FELT-HAT" }, store);

  assertEquals(view.batchref, null);
  assertEquals(store.allocations.get("o-1/FELT-HAT"), view);
  assertEquals(
    store.products.get("FELT-HAT")!.value.batches[0].allocations,
    [],
  );
  const version = store.products.get("FELT-HAT")!.version;
  await deallocate({ orderid: "o-1", sku: "FELT-HAT" }, store);
  assertEquals(store.products.get("FELT-HAT")!.version, version);
  // The event names the batch the line left; releasing it again says nothing.
  assertEquals(
    store.events.map((e) => [e.type, "batchref" in e && e.batchref]),
    [
      ["Allocated", "b-1"],
      ["Deallocated", "b-1"],
    ],
  );

  const again = await allocate({ orderid: "o-1", sku: "FELT-HAT" }, store);
  assertEquals(again.batchref, "b-1");
  await assertRejects(
    () => deallocate({ orderid: "o-9", sku: "FELT-HAT" }, store),
    UnknownOrderLine,
  );
});

Deno.test("changing a batch quantity saves the product once and updates the read model of every moved line", async () => {
  const store = new InMemoryStore();
  await addBatch({ ref: "wh", sku: "FELT-HAT", qty: 10 }, store);
  await addBatch(
    { ref: "ship", sku: "FELT-HAT", qty: 3, eta: "2027-02-01" },
    store,
  );
  for (const [orderid, qty] of [["o-1", 5], ["o-2", 3], ["o-3", 2]] as const) {
    await createOrderLine({ orderid, sku: "FELT-HAT", qty }, store);
    await allocate({ orderid, sku: "FELT-HAT" }, store);
  }
  const version = store.products.get("FELT-HAT")!.version;

  // 4 cannot cover o-1 (5) alone, so all three are released: o-3, o-2, o-1.
  // Oldest first: o-1 (5) fits nowhere; o-2 (3) fits the warehouse's 4, which
  // is preferred; o-3 (2) then takes the shipment.
  const moved = await changeBatchQuantity({
    ref: "wh",
    sku: "FELT-HAT",
    qty: 4,
  }, store);

  assertEquals(moved.map((v) => [v.orderid, v.batchref]), [
    ["o-1", null],
    ["o-2", "wh"],
    ["o-3", "ship"],
  ]);
  assertEquals(store.products.get("FELT-HAT")!.version, version + 1);
  assertEquals(store.allocations.get("o-1/FELT-HAT")!.batchref, null);
  assertEquals(store.allocations.get("o-2/FELT-HAT")!.batchref, "wh");
  assertEquals(store.allocations.get("o-3/FELT-HAT")!.batchref, "ship");
  // o-2 went back into the batch it left, so only o-1 and o-3 are news.
  assertEquals(store.events.slice(3), [
    {
      type: "Deallocated",
      orderid: "o-1",
      sku: "FELT-HAT",
      qty: 5,
      batchref: "wh",
    },
    {
      type: "Allocated",
      orderid: "o-3",
      sku: "FELT-HAT",
      qty: 2,
      batchref: "ship",
    },
  ]);
  await assertRejects(
    () => changeBatchQuantity({ ref: "wh", sku: "NOPE", qty: 1 }, store),
    UnknownSku,
  );
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
