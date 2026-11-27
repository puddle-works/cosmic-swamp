/**
 * AllocationStore backed by Swamp's datastore. Every record is a resource of
 * the one behavior instance running the method:
 *
 * - `product-<sku>`: the Product aggregate (spec `product`)
 * - `line-<orderid>-<sku>`: an order line (spec `orderLine`)
 * - `allocation-<orderid>-<sku>`: the allocation read model (spec `allocation`)
 *
 * Lost updates are refused twice over. Mutating methods of one behavior
 * instance run under its per-behavior lock, so two commands never interleave
 * on a healthy datastore. And the store does not trust that alone: a product
 * read at version N must be written as version N+1. Versions are claimed
 * atomically (mkdir), so if another writer got in first the write lands at a
 * higher number and the store throws ConcurrentUpdate; the method sets
 * `rollbackOnFailure`, so Swamp then discards every write of the run.
 *
 * @module
 */

import type { OrderLine, ProductState } from "./domain.ts";
import { Product } from "./domain.ts";
import {
  type AllocationEvent,
  type AllocationStore,
  type AllocationView,
  ConcurrentUpdate,
  type Versioned,
} from "./service.ts";

/** The subset of Swamp's MethodContext this store needs. */
export interface StoreContext {
  modelType: unknown;
  modelId: string;
  dataRepository: {
    findByName(
      type: never,
      modelId: string,
      name: string,
    ): Promise<{ version: number; lifecycle?: string } | null>;
  };
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource?: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandleLike>;
}

export interface DataHandleLike {
  name: string;
  version: number;
}

export const productName = (sku: string) => `product-${sku}`;
export const lineName = (orderid: string, sku: string) =>
  `line-${orderid}-${sku}`;
export const allocationName = (orderid: string, sku: string) =>
  `allocation-${orderid}-${sku}`;

/** Stored product: the aggregate state plus derived quantities, so queries can read stock without domain code. */
export function productRecord(state: ProductState): Record<string, unknown> {
  const product = Product.fromState(state);
  return {
    sku: state.sku,
    availableQuantity: product.availableQuantity,
    batches: product.batches.map((b) => ({
      ...b.toState(),
      allocatedQuantity: b.allocatedQuantity,
      availableQuantity: b.availableQuantity,
    })),
  };
}

export class SwampStore implements AllocationStore {
  /** Every handle this command wrote, returned by the method so Swamp lists them. */
  readonly handles: DataHandleLike[] = [];
  /** Events the command recorded, sent by the behavior after its writes. */
  readonly events: AllocationEvent[] = [];

  constructor(private ctx: StoreContext) {}

  async #latest(name: string): Promise<number | null> {
    const found = await this.ctx.dataRepository.findByName(
      this.ctx.modelType as never,
      this.ctx.modelId,
      name,
    );
    return found && found.lifecycle !== "deleted" ? found.version : null;
  }

  async #read(
    name: string,
  ): Promise<Versioned<Record<string, unknown>> | null> {
    const version = await this.#latest(name);
    if (version === null) return null;
    const value = await this.ctx.readResource!(name, version);
    return value ? { value, version } : null;
  }

  async #write(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandleLike> {
    const handle = await this.ctx.writeResource!(spec, name, data);
    this.handles.push(handle);
    return handle;
  }

  async getProduct(sku: string): Promise<Versioned<ProductState> | null> {
    const found = await this.#read(productName(sku));
    if (!found) return null;
    const { sku: storedSku, batches } = found.value as unknown as ProductState;
    return {
      value: {
        sku: storedSku,
        batches: batches.map((
          { reference, sku, purchasedQuantity, eta, allocations },
        ) => ({
          reference,
          sku,
          purchasedQuantity,
          eta,
          allocations,
        })),
      },
      version: found.version,
    };
  }

  async saveProduct(
    product: ProductState,
    readVersion: number | null,
  ): Promise<void> {
    const name = productName(product.sku);
    const current = await this.#latest(name);
    if (current !== readVersion) {
      throw new ConcurrentUpdate(product.sku, readVersion, current ?? 0);
    }
    const handle = await this.#write("product", name, productRecord(product));
    const expected = (readVersion ?? 0) + 1;
    if (handle.version !== expected) {
      throw new ConcurrentUpdate(product.sku, readVersion, handle.version - 1);
    }
  }

  async getOrderLine(orderid: string, sku: string): Promise<OrderLine | null> {
    const found = await this.#read(lineName(orderid, sku));
    if (!found) return null;
    const { qty } = found.value as { qty: number };
    return { orderid, sku, qty };
  }

  async saveOrderLine(line: OrderLine): Promise<void> {
    await this.#write("orderLine", lineName(line.orderid, line.sku), {
      ...line,
    });
  }

  recordEvent(event: AllocationEvent): void {
    this.events.push(event);
  }

  async saveAllocation(view: AllocationView): Promise<void> {
    await this.#write("allocation", allocationName(view.orderid, view.sku), {
      ...view,
    });
  }
}
