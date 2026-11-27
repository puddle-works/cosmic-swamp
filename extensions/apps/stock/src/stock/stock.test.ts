import { expect, test } from "bun:test";
import { connectApp, createMockHost } from "@swamp-club/app-sdk";
import { allocateOutcome, allocationRows, batchInputs, batchRows, orderInputs, PRODUCTS_QUERY, quantityInputs, totalsBySku } from "./stock.ts";

const product = {
  sku: "LAMP",
  availableQuantity: 25,
  batches: [
    { reference: "ship-late", sku: "LAMP", purchasedQuantity: 10, eta: "2027-03-01", allocatedQuantity: 0, availableQuantity: 10, allocations: [] },
    { reference: "wh", sku: "LAMP", purchasedQuantity: 8, eta: null, allocatedQuantity: 3, availableQuantity: 5, allocations: [] },
    { reference: "ship-soon", sku: "LAMP", purchasedQuantity: 10, eta: "2027-01-01", allocatedQuantity: 0, availableQuantity: 10, allocations: [] },
  ],
};

test("batches list warehouse stock first, then shipments by ETA, and skip malformed records", () => {
  const rows = batchRows([product, { sku: "BROKEN" }, null]);
  expect(rows.map((r) => r.reference)).toEqual(["wh", "ship-soon", "ship-late"]);
  expect(totalsBySku(rows)).toEqual([{ sku: "LAMP", available: 25 }]);
});

test("allocations need every field; a null batch means released, a missing one is malformed", () => {
  expect(
    allocationRows([
      { orderid: "o-1", sku: "LAMP", qty: 3, batchref: "wh" },
      { orderid: "o-2", sku: "LAMP", qty: 1, batchref: null },
      { orderid: "o-3", sku: "LAMP", qty: 1 },
      { orderid: "o-4" },
    ]),
  ).toEqual([
    { orderid: "o-1", sku: "LAMP", qty: 3, batchref: "wh" },
    { orderid: "o-2", sku: "LAMP", qty: 1, batchref: null },
  ]);
});

test("a batch quantity may change to 0 but not below, and must be given", () => {
  expect(quantityInputs({ ref: " wh ", sku: "LAMP", qty: "0" })).toEqual({ inputs: { ref: "wh", sku: "LAMP", qty: 0 } });
  expect(quantityInputs({ ref: "wh", sku: "LAMP", qty: "-1" })).toHaveProperty("error");
  expect(quantityInputs({ ref: "wh", sku: "LAMP", qty: "" })).toHaveProperty("error");
});

test("form values become method inputs, and the arrival date is optional", () => {
  expect(batchInputs({ ref: " b-1 ", sku: "LAMP", qty: "4", eta: "" })).toEqual({
    inputs: { ref: "b-1", sku: "LAMP", qty: 4 },
  });
  expect(batchInputs({ ref: "b-1", sku: "LAMP", qty: "2.5", eta: "" })).toHaveProperty("error");
  expect(orderInputs({ orderid: "o-1", sku: "LAMP", qty: "0" })).toHaveProperty("error");
});

test("the products query is answered through a host granting data:read", async () => {
  const host = createMockHost({
    app: { capabilities: ["data:read"] },
    responses: { "data.query": { data: { predicate: PRODUCTS_QUERY, results: [{ content: product }], total: 1, limited: false } } },
  });
  const { client } = await connectApp({}, host.port);
  const reply = (await client.request("data.query", { predicate: PRODUCTS_QUERY })) as {
    data: { results: Array<{ content: unknown }> };
  };
  expect(batchRows(reply.data.results.map((r) => r.content))).toHaveLength(3);
});

test("an allocate run reports its batch, or the out-of-stock reason from its event", () => {
  expect(allocateOutcome("o-1", [{ name: "allocation-o-1-LAMP", attributes: { orderid: "o-1", batchref: "wh" } }])).toEqual({
    kind: "ok",
    text: "Allocated order o-1 to wh",
  });
  const outOfStock = allocateOutcome("o-2", [
    { name: "allocation-o-2-LAMP", attributes: { orderid: "o-2", batchref: null } },
    { name: "event-x", attributes: { type: "OutOfStock", sku: "LAMP", qty: 50, available: 10 } },
  ]);
  expect(outOfStock.kind).toBe("error");
  expect(outOfStock.text).toContain("requested 50, largest available in any batch is 10");
});
