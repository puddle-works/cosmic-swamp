import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { behavior } from "./allocation.ts";
import { fakeContext } from "./fake_context.ts";

/** A method context over the fake datastore that records log lines by level. */
function methodContext() {
  const { ctx, data } = fakeContext();
  const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const logger = {
    info: (msg: string, p?: Record<string, unknown>) =>
      logs.push(["info", msg, p]),
    warn: (msg: string, p?: Record<string, unknown>) =>
      logs.push(["warn", msg, p]),
  };
  return { context: { ...ctx, logger }, data, logs };
}

// Webhook and CLI arguments arrive as strings.
const args = <T>(a: Record<string, string>) => a as unknown as T;

Deno.test("string arguments are coerced, and an impossible date is refused before anything is written", async () => {
  const { context, data } = methodContext();
  const { add_batch } = behavior.methods;
  await assertRejects(() =>
    add_batch.execute(
      args({ ref: "b-1", sku: "OAK-STOOL", qty: "5", eta: "2026-02-30" }),
      context,
    )
  );
  assertEquals(data.size, 0);

  await add_batch.execute(
    args({ ref: "b-1", sku: "OAK-STOOL", qty: "5" }),
    context,
  );
  assertEquals(
    data.get("product-OAK-STOOL")?.at(-1)?.availableQuantity,
    5,
  );
});

Deno.test("allocate returns what it wrote, and warns instead of failing when out of stock", async () => {
  const { context, data, logs } = methodContext();
  const m = behavior.methods;
  await m.add_batch.execute(
    args({ ref: "b-1", sku: "OAK", qty: "2" }),
    context,
  );
  await m.create_order_line.execute(
    args({ orderid: "o-big", sku: "OAK", qty: "3" }),
    context,
  );
  await m.create_order_line.execute(
    args({ orderid: "o-small", sku: "OAK", qty: "1" }),
    context,
  );

  const big = await m.allocate.execute(
    { orderid: "o-big", sku: "OAK" },
    context,
  );
  const bigNames = big.dataHandles.map((h) => h.name);
  assertEquals(bigNames.includes("allocation-o-big-OAK"), true);
  assertEquals(bigNames.includes("product-OAK"), false);
  const outOfStock = bigNames.find((n) => n.startsWith("event-"))!;
  assertEquals(data.get(outOfStock)?.[0]?.type, "OutOfStock");
  assertEquals(logs.at(-1)?.[0], "warn");

  const small = await m.allocate.execute(
    { orderid: "o-small", sku: "OAK" },
    context,
  );
  assertEquals(
    data.get("allocation-o-small-OAK")?.at(-1)?.batchref,
    "b-1",
  );
  assertEquals(
    small.dataHandles.some((h) => h.name === "product-OAK"),
    true,
  );
  assertEquals(logs.at(-1)?.[0], "info");
});

Deno.test("allocating an order line that was never recorded fails", async () => {
  const { context } = methodContext();
  await behavior.methods.add_batch.execute(
    args({ ref: "b-1", sku: "OAK", qty: "2" }),
    context,
  );
  await assertRejects(() =>
    behavior.methods.allocate.execute({ orderid: "o-x", sku: "OAK" }, context)
  );
});
