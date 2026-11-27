/**
 * `@puddleworks/allocation`: the stock allocation service as a Swamp behavior.
 *
 * Each method is one command from the book's service layer. The method body
 * validates its arguments (zod, at Swamp's boundary), builds a SwampStore on
 * the method context and calls the service function. No business rule lives
 * here.
 *
 * @module
 */

import { z } from "npm:zod@4";
import * as service from "./service.ts";
import { type StoreContext, SwampStore } from "./swamp_store.ts";

/** Identifiers become part of resource names, so keep them portable. */
const Identifier = z.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  "letters, digits, '-' and '_' only (1-64)",
);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
      new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    "a real calendar date",
  );

const Quantity = z.coerce.number().int().positive();

const AddBatchArgs = z.object({
  ref: Identifier.describe("Batch reference, unique within the SKU"),
  sku: Identifier.describe("Stock-keeping unit"),
  qty: Quantity.describe("Purchased quantity"),
  eta: IsoDate.optional().describe(
    "Arrival date; omit for stock already in the warehouse",
  ),
});

const OrderLineArgs = z.object({
  orderid: Identifier.describe("Order reference"),
  sku: Identifier.describe("Stock-keeping unit"),
  qty: Quantity.describe("Quantity ordered"),
});

const AllocateArgs = z.object({
  orderid: Identifier.describe("Order reference"),
  sku: Identifier.describe("Stock-keeping unit of a recorded order line"),
});

const OrderLineSchema = z.object({
  orderid: z.string(),
  sku: z.string(),
  qty: z.number(),
});

const BatchSchema = z.object({
  reference: z.string(),
  sku: z.string(),
  purchasedQuantity: z.number(),
  eta: z.string().nullable(),
  allocations: z.array(OrderLineSchema),
  allocatedQuantity: z.number(),
  availableQuantity: z.number(),
});

type Context = StoreContext & {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** Runs a service command against the datastore and returns what it wrote. */
async function run<T>(
  context: Context,
  command: (store: SwampStore) => Promise<T>,
) {
  const store = new SwampStore(context);
  const result = await command(store);
  return { result, dataHandles: store.handles };
}

export const behavior = {
  type: "@puddleworks/allocation",
  version: "2026.11.27.1",
  globalArguments: z.object({}),
  resources: {
    product: {
      description:
        "Product aggregate: every batch of one SKU with its allocations and remaining stock",
      schema: z.object({
        sku: z.string(),
        availableQuantity: z.number(),
        batches: z.array(BatchSchema),
      }),
      lifetime: "infinite",
      garbageCollection: 50,
    },
    orderLine: {
      description: "An order line awaiting or holding an allocation",
      schema: OrderLineSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    allocation: {
      description: "Read model: the batch an order line was allocated to",
      schema: OrderLineSchema.extend({ batchref: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    add_batch: {
      description: "Add a stock batch for a SKU, optionally arriving on a date",
      kind: "create",
      rollbackOnFailure: true,
      arguments: AddBatchArgs,
      execute: async (args: z.infer<typeof AddBatchArgs>, context: Context) => {
        const cmd = AddBatchArgs.parse(args);
        const { dataHandles } = await run(
          context,
          (store) => service.addBatch(cmd, store),
        );
        context.logger.info(
          "Added batch {ref} of {qty} x {sku}",
          cmd.ref,
          cmd.qty,
          cmd.sku,
        );
        return { dataHandles };
      },
    },
    create_order_line: {
      description:
        "Record an order line for a known SKU (idempotent for the same quantity)",
      kind: "create",
      rollbackOnFailure: true,
      arguments: OrderLineArgs,
      execute: async (
        args: z.infer<typeof OrderLineArgs>,
        context: Context,
      ) => {
        const line = OrderLineArgs.parse(args);
        const { dataHandles } = await run(
          context,
          (store) => service.createOrderLine(line, store),
        );
        return { dataHandles };
      },
    },
    allocate: {
      description:
        "Allocate a recorded order line to the preferred batch; fails when stock is insufficient",
      kind: "update",
      rollbackOnFailure: true,
      arguments: AllocateArgs,
      execute: async (args: z.infer<typeof AllocateArgs>, context: Context) => {
        const cmd = AllocateArgs.parse(args);
        const { result, dataHandles } = await run(
          context,
          (store) => service.allocate(cmd, store),
        );
        context.logger.info(
          "Allocated {orderid} to batch {batchref}",
          result.orderid,
          result.batchref,
        );
        return { dataHandles };
      },
    },
  },
};
