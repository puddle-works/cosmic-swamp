import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { ConcurrentUpdate } from "./service.ts";
import { fakeContext } from "./fake_context.ts";
import { productName, SwampStore } from "./swamp_store.ts";

const state = { sku: "OAK-STOOL", batches: [] };

Deno.test("a product save refuses a version it did not read", async () => {
  const { ctx } = fakeContext();
  const store = new SwampStore(ctx);
  await store.saveProduct(state, null);
  await assertRejects(() => store.saveProduct(state, null), ConcurrentUpdate);
});

Deno.test("a write that lands past readVersion + 1 is reported as a lost update", async () => {
  const { ctx, data } = fakeContext();
  const store = new SwampStore(ctx);
  await store.saveProduct(state, null);
  // Another writer claims version 2 between this store's check and its write.
  const realFind = ctx.dataRepository.findByName;
  ctx.dataRepository.findByName = async (t, id, name) => {
    const found = await realFind(t, id, name);
    data.get(productName("OAK-STOOL"))!.push({ ...state });
    ctx.dataRepository.findByName = realFind;
    return found;
  };
  await assertRejects(
    () => store.saveProduct(state, 1),
    ConcurrentUpdate,
    "found version 2",
  );
});

Deno.test("a stored product reads back as plain aggregate state, without derived fields", async () => {
  const { ctx } = fakeContext();
  const store = new SwampStore(ctx);
  const product = {
    sku: "OAK-STOOL",
    batches: [{
      reference: "b-1",
      sku: "OAK-STOOL",
      purchasedQuantity: 5,
      eta: null,
      allocations: [],
    }],
  };
  await store.saveProduct(product, null);
  assertEquals(await store.getProduct("OAK-STOOL"), {
    value: product,
    version: 1,
  });
});
