import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { ConcurrentUpdate } from "./service.ts";
import { type DataHandleLike, productName, SwampStore } from "./swamp_store.ts";

/** A fake datastore that numbers versions like Swamp: each write takes the next free number per name. */
function fakeContext() {
  const data = new Map<string, Array<Record<string, unknown>>>();
  const write = (
    _spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<DataHandleLike> => {
    const versions = data.get(name) ?? [];
    versions.push(structuredClone(value));
    data.set(name, versions);
    return Promise.resolve({ name, version: versions.length });
  };
  return {
    data,
    ctx: {
      modelType: "@puddleworks/allocation",
      modelId: "m-1",
      dataRepository: {
        findByName: (_t: never, _id: string, name: string) => {
          const n = data.get(name)?.length ?? 0;
          return Promise.resolve(n ? { version: n } : null);
        },
      },
      readResource: (name: string, version?: number) => {
        const versions = data.get(name) ?? [];
        return Promise.resolve(
          versions[(version ?? versions.length) - 1] ?? null,
        );
      },
      writeResource: write,
    },
  };
}

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
