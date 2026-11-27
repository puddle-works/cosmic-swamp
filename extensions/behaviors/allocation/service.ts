/**
 * Service layer: one function per use case. Each takes a plain command and
 * the store it persists through, and knows nothing about Swamp. The behavior
 * in `allocation.ts` is the only caller in production; tests call these with
 * an in-memory store.
 *
 * @module
 */

import {
  DomainError,
  type OrderLine,
  Product,
  type ProductState,
} from "./domain.ts";

/** A stored value together with the datastore version it was read at. */
export interface Versioned<T> {
  value: T;
  version: number;
}

/** Where an order line is allocated; stored as the `allocation` read model. `batchref` is null once the line has been released and not reallocated. */
export interface AllocationView {
  orderid: string;
  sku: string;
  qty: number;
  batchref: string | null;
}

/**
 * The persistence port (the book's repository). Products are saved with the
 * version they were read at, so an implementation can refuse a save that
 * would overwrite a write it never saw.
 */
export interface AllocationStore {
  getProduct(sku: string): Promise<Versioned<ProductState> | null>;
  /** `readVersion` is null for a product that did not exist when read. Throws ConcurrentUpdate on a lost update. */
  saveProduct(product: ProductState, readVersion: number | null): Promise<void>;
  getOrderLine(orderid: string, sku: string): Promise<OrderLine | null>;
  saveOrderLine(line: OrderLine): Promise<void>;
  saveAllocation(view: AllocationView): Promise<void>;
}

/** The SKU has no product, so nothing can be allocated against it. */
export class UnknownSku extends DomainError {
  constructor(readonly sku: string) {
    super(`Unknown SKU ${sku}: add a batch for it first`);
  }
}

/** Allocation was asked for an order line that was never created. */
export class UnknownOrderLine extends DomainError {
  constructor(readonly orderid: string, readonly sku: string) {
    super(`No order line for order ${orderid} and SKU ${sku}`);
  }
}

/** An order line already exists for this order and SKU with a different quantity. */
export class ConflictingOrderLine extends DomainError {
  constructor(readonly existing: OrderLine) {
    super(
      `Order ${existing.orderid} already has a line for SKU ${existing.sku} with quantity ${existing.qty}`,
    );
  }
}

/** Another writer saved the product after this command read it. Retrying the command is safe. */
export class ConcurrentUpdate extends DomainError {
  constructor(
    readonly sku: string,
    readonly readVersion: number | null,
    readonly seenVersion: number,
  ) {
    super(
      `Product ${sku} changed while this command ran (read at version ${
        readVersion ?? "none"
      }, ` +
        `found version ${seenVersion}); nothing was saved, retry the command`,
    );
  }
}

export interface AddBatch {
  ref: string;
  sku: string;
  qty: number;
  eta?: string | null;
}

/** Adds a batch, creating the product on its first batch. */
export async function addBatch(
  cmd: AddBatch,
  store: AllocationStore,
): Promise<ProductState> {
  const stored = await store.getProduct(cmd.sku);
  const product = stored
    ? Product.fromState(stored.value)
    : new Product(cmd.sku);
  product.addBatch(cmd.ref, cmd.qty, cmd.eta ?? null);
  const state = product.toState();
  await store.saveProduct(state, stored?.version ?? null);
  return state;
}

/** Records an order line. Creating the same line again is a no-op. */
export async function createOrderLine(
  line: OrderLine,
  store: AllocationStore,
): Promise<OrderLine> {
  if (!(await store.getProduct(line.sku))) throw new UnknownSku(line.sku);
  const existing = await store.getOrderLine(line.orderid, line.sku);
  if (existing) {
    if (existing.qty !== line.qty) throw new ConflictingOrderLine(existing);
    return existing;
  }
  await store.saveOrderLine(line);
  return line;
}

export interface Allocate {
  orderid: string;
  sku: string;
}

/** Allocates a recorded order line to a batch and returns the allocation. */
export async function allocate(
  cmd: Allocate,
  store: AllocationStore,
): Promise<AllocationView> {
  const line = await store.getOrderLine(cmd.orderid, cmd.sku);
  if (!line) throw new UnknownOrderLine(cmd.orderid, cmd.sku);
  const stored = await store.getProduct(line.sku);
  if (!stored) throw new UnknownSku(line.sku);

  const product = Product.fromState(stored.value);
  const alreadyIn = product.allocationOf(line);
  const batchref = product.allocate(line);
  if (!alreadyIn) await store.saveProduct(product.toState(), stored.version);

  const view = {
    orderid: line.orderid,
    sku: line.sku,
    qty: line.qty,
    batchref,
  };
  await store.saveAllocation(view);
  return view;
}

export interface Deallocate {
  orderid: string;
  sku: string;
}

/**
 * Releases a recorded order line from its batch. Releasing a line that is
 * not allocated changes nothing. `allocate` can allocate it again.
 */
export async function deallocate(
  cmd: Deallocate,
  store: AllocationStore,
): Promise<AllocationView> {
  const line = await store.getOrderLine(cmd.orderid, cmd.sku);
  if (!line) throw new UnknownOrderLine(cmd.orderid, cmd.sku);
  const view = { ...line, batchref: null };
  const stored = await store.getProduct(line.sku);
  if (!stored) throw new UnknownSku(line.sku);

  const product = Product.fromState(stored.value);
  if (product.deallocate(line) === null) return view;
  await store.saveProduct(product.toState(), stored.version);
  await store.saveAllocation(view);
  return view;
}

export interface ChangeBatchQuantity {
  ref: string;
  sku: string;
  qty: number;
}

/**
 * Sets a batch's purchased quantity and reallocates the lines it can no
 * longer cover, all in one save of the product. Returns an allocation view
 * for every line that moved; a null `batchref` means no batch had room.
 */
export async function changeBatchQuantity(
  cmd: ChangeBatchQuantity,
  store: AllocationStore,
): Promise<AllocationView[]> {
  const stored = await store.getProduct(cmd.sku);
  if (!stored) throw new UnknownSku(cmd.sku);

  const product = Product.fromState(stored.value);
  const moved = product.changeBatchQuantity(cmd.ref, cmd.qty).map((
    { line, batchref },
  ) => ({ ...line, batchref }));
  await store.saveProduct(product.toState(), stored.version);
  for (const view of moved) await store.saveAllocation(view);
  return moved;
}
