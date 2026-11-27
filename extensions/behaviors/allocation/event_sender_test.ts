import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { sendEvent, sign } from "./event_sender.ts";

Deno.test("signatures are HMAC-SHA256 in hex (RFC 4231 test case 2)", async () => {
  assertEquals(
    await sign("what do ya want for nothing?", "Jefe"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

Deno.test("an event is posted as JSON signed over the exact body, and a refusal throws", async () => {
  const sent: Request[] = [];
  let status = 204;
  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return Promise.resolve(new Response(null, { status }));
  };
  const event = {
    type: "Allocated" as const,
    orderid: "o-1",
    sku: "LAMP",
    qty: 2,
    batchref: "wh",
  };

  await sendEvent("https://example.test/events", "s3cret", event, fakeFetch);

  const body = await sent[0].text();
  assertEquals(
    sent[0].headers.get("x-puddleworks-signature"),
    `sha256=${await sign(body, "s3cret")}`,
  );
  const { id, at, ...rest } = JSON.parse(body);
  assertEquals(rest, event);
  assertEquals([typeof id, Number.isNaN(Date.parse(at))], ["string", false]);

  status = 401;
  await assertRejects(
    () => sendEvent("https://example.test/events", "s3cret", event, fakeFetch),
    Error,
    "401",
  );
});
