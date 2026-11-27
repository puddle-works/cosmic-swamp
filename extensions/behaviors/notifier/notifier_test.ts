import { assertEquals } from "jsr:@std/assert@1.0.19";
import { behavior } from "./notifier.ts";

// Run with --allow-env: dispatch reads STOCK_EVENTS_URL and STOCK_EVENTS_SECRET.

const event = (id: string, at: string) => ({
  id,
  at,
  type: "Allocated",
  orderid: `o-${id}`,
  sku: "OAK",
  qty: 1,
  batchref: "b-1",
});

/** A dispatch context whose datastore holds these events and deliveries. */
function methodContext(
  events: unknown[],
  deliveredIds: string[] = [],
) {
  const written: Array<{ name: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const log = (level: string) => (msg: string) => logs.push(`${level}: ${msg}`);
  const context = {
    modelId: "notifier-1",
    logger: { info: log("info"), warn: log("warn") },
    queryData: (predicate: string) =>
      Promise.resolve(
        predicate.includes('specName == "event"')
          ? events.map((attributes) => ({ attributes }))
          : deliveredIds.map((eventId) => ({ attributes: { eventId } })),
      ),
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ name, data });
      return Promise.resolve({ name, version: 1 });
    },
  };
  return { context, written, logs };
}

/** Runs `fn` with the receiver env set and fetch answering `status(i)` to the i-th post. */
async function withReceiver(
  status: (i: number) => number,
  fn: (posted: string[]) => Promise<void>,
) {
  const realFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (_url, init) => {
    posted.push(JSON.parse(String(init?.body)).id);
    return Promise.resolve(
      new Response(null, { status: status(posted.length - 1) }),
    );
  };
  Deno.env.set("STOCK_EVENTS_URL", "https://receiver.example.com/events");
  Deno.env.set("STOCK_EVENTS_SECRET", "test-secret");
  try {
    await fn(posted);
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("STOCK_EVENTS_URL");
    Deno.env.delete("STOCK_EVENTS_SECRET");
  }
}

Deno.test("without a receiver configured, dispatch delivers nothing and records nothing", async () => {
  const { context, written } = methodContext([
    event("a", "2026-11-28T09:00:00Z"),
  ]);
  const result = await behavior.methods.dispatch.execute(
    { limit: 100 },
    context,
  );
  assertEquals(result.dataHandles, []);
  assertEquals(written, []);
});

Deno.test("dispatch sends undelivered events oldest first, records each accepted one, and stops at the first refusal", async () => {
  const { context, written, logs } = methodContext(
    [
      event("c", "2026-11-28T09:03:00Z"),
      event("a", "2026-11-28T09:01:00Z"),
      event("old", "2026-11-28T09:00:00Z"),
      event("b", "2026-11-28T09:02:00Z"),
    ],
    ["old"],
  );
  await withReceiver((i) => (i === 1 ? 503 : 204), async (posted) => {
    await behavior.methods.dispatch.execute({ limit: 100 }, context);
    assertEquals(posted, ["a", "b"]);
  });
  assertEquals(written.map((w) => w.name), ["delivery-a"]);
  assertEquals(written[0].data.eventId, "a");
  assertEquals(logs.at(-1)?.startsWith("warn:"), true);
});
