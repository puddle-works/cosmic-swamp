import { expect, test } from "bun:test";
import { connectApp, createMockHost } from "@swamp-club/app-sdk";
import { allocationRows, batchInputs, batchRows, orderInputs, PRODUCTS_QUERY, totalsBySku } from "./stock.ts";

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

test("allocations need every field", () => {
  expect(allocationRows([{ orderid: "o-1", sku: "LAMP", qty: 3, batchref: "wh" }, { orderid: "o-2" }])).toEqual([
    { orderid: "o-1", sku: "LAMP", qty: 3, batchref: "wh" },
  ]);
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
