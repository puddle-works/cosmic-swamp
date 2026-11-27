import { assertEquals } from "jsr:@std/assert@1.0.19";
import { pendingEvents } from "./outbox.ts";

const event = (id: string, at: string) => ({
  id,
  at,
  type: "Allocated",
  orderid: `o-${id}`,
  sku: "LAMP",
  qty: 1,
  batchref: "wh",
});

Deno.test("pending events are the undelivered ones, oldest first, capped, skipping malformed records", () => {
  const events = [
    event("c", "2026-11-28T09:00:03Z"),
    event("a", "2026-11-28T09:00:01Z"),
    { id: "broken" },
    undefined,
    event("b", "2026-11-28T09:00:02Z"),
    event("d", "2026-11-28T09:00:04Z"),
  ];
  assertEquals(
    pendingEvents(events, ["b", undefined], 2).map((e) => e.id),
    ["a", "c"],
  );
  assertEquals(pendingEvents(events, ["a", "b", "c", "d"], 10), []);
});
