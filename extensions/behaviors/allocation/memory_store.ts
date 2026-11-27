/**
 * In-memory AllocationStore for service-layer tests. It keeps a version per
 * product exactly as the Swamp store does, so tests can show what a lost
 * update looks like without a datastore.
 *
 * @module
 */

import type { DomainEvent, OrderLine, ProductState } from "./domain.ts";
import {
  type AllocationStore,
  type AllocationView,
  ConcurrentUpdate,
  type Versioned,
} from "./service.ts";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryStore implements AllocationStore {
  products = new Map<string, Versioned<ProductState>>();
  lines = new Map<string, OrderLine>();
  allocations = new Map<string, AllocationView>();
  events: DomainEvent[] = [];
  productSaves = 0;

  getProduct(sku: string): Promise<Versioned<ProductState> | null> {
    const found = this.products.get(sku);
    return Promise.resolve(found ? clone(found) : null);
  }

  saveProduct(
    product: ProductState,
    readVersion: number | null,
  ): Promise<void> {
    const current = this.products.get(product.sku)?.version ?? null;
    if (current !== readVersion) {
      return Promise.reject(
        new ConcurrentUpdate(product.sku, readVersion, current ?? 0),
      );
    }
    this.products.set(product.sku, {
      value: clone(product),
      version: (current ?? 0) + 1,
    });
    this.productSaves++;
    return Promise.resolve();
  }

  getOrderLine(orderid: string, sku: string): Promise<OrderLine | null> {
    return Promise.resolve(clone(this.lines.get(`${orderid}/${sku}`) ?? null));
  }

  saveOrderLine(line: OrderLine): Promise<void> {
    this.lines.set(`${line.orderid}/${line.sku}`, clone(line));
    return Promise.resolve();
  }

  saveAllocation(view: AllocationView): Promise<void> {
    this.allocations.set(`${view.orderid}/${view.sku}`, clone(view));
    return Promise.resolve();
  }

  saveEvent(event: DomainEvent): Promise<void> {
    this.events.push(clone(event));
    return Promise.resolve();
  }
}
