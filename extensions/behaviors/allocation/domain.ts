/**
 * Stock allocation domain model.
 *
 * Pure TypeScript: no Swamp, no I/O. Everything here can be tested with plain
 * `deno test`. The persistence shape is plain JSON (`ProductState`), so the
 * aggregate can be rebuilt from, and turned back into, a stored resource.
 *
 * @module
 */

/** A customer's request for some quantity of one SKU, as part of an order. */
export interface OrderLine {
  readonly orderid: string;
  readonly sku: string;
  readonly qty: number;
}

/** Stored form of a batch. `eta` is an ISO date (YYYY-MM-DD) or null when the stock is already in the warehouse. */
export interface BatchState {
  reference: string;
  sku: string;
  purchasedQuantity: number;
  eta: string | null;
  allocations: OrderLine[];
}

/** Stored form of the Product aggregate: every batch of one SKU. */
export interface ProductState {
  sku: string;
  batches: BatchState[];
}

/** Base class for rule violations a caller can act on. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No batch of the SKU has enough unallocated stock for the line. */
export class OutOfStock extends DomainError {
  constructor(
    readonly sku: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      `Insufficient stock for SKU ${sku}: requested ${requested}, largest available in any batch is ${available}`,
    );
  }
}

/** The command names a batch reference that the product already holds. */
export class DuplicateBatch extends DomainError {
  constructor(readonly reference: string) {
    super(`Batch ${reference} already exists`);
  }
}

/** A line was offered to a product of a different SKU. */
export class SkuMismatch extends DomainError {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Order line SKU ${actual} does not belong to product ${expected}`);
  }
}

const sameLine = (a: OrderLine, b: OrderLine) =>
  a.orderid === b.orderid && a.sku === b.sku && a.qty === b.qty;

/** A quantity of one SKU, either in the warehouse (`eta === null`) or arriving on `eta`. */
export class Batch {
  readonly reference: string;
  readonly sku: string;
  readonly eta: string | null;
  #purchased: number;
  #allocations: OrderLine[];

  constructor(
    reference: string,
    sku: string,
    qty: number,
    eta: string | null = null,
    allocations: OrderLine[] = [],
  ) {
    this.reference = reference;
    this.sku = sku;
    this.eta = eta;
    this.#purchased = qty;
    this.#allocations = [...allocations];
  }

  static fromState(state: BatchState): Batch {
    return new Batch(
      state.reference,
      state.sku,
      state.purchasedQuantity,
      state.eta,
      state.allocations,
    );
  }

  toState(): BatchState {
    return {
      reference: this.reference,
      sku: this.sku,
      purchasedQuantity: this.#purchased,
      eta: this.eta,
      allocations: this.#allocations.map((l) => ({ ...l })),
    };
  }

  get purchasedQuantity(): number {
    return this.#purchased;
  }

  get allocatedQuantity(): number {
    return this.#allocations.reduce((sum, l) => sum + l.qty, 0);
  }

  get availableQuantity(): number {
    return this.#purchased - this.allocatedQuantity;
  }

  get allocations(): readonly OrderLine[] {
    return this.#allocations;
  }

  holds(line: OrderLine): boolean {
    return this.#allocations.some((l) => sameLine(l, line));
  }

  canAllocate(line: OrderLine): boolean {
    return this.sku === line.sku && this.availableQuantity >= line.qty;
  }

  /** Allocates the line if it fits. Allocating a line the batch already holds changes nothing. */
  allocate(line: OrderLine): void {
    if (this.holds(line) || !this.canAllocate(line)) return;
    this.#allocations.push({ ...line });
  }

  /** Releases the line if the batch holds it; otherwise changes nothing. */
  deallocate(line: OrderLine): void {
    this.#allocations = this.#allocations.filter((l) => !sameLine(l, line));
  }
}

/**
 * Warehouse stock arrives before any shipment; among shipments the earliest
 * ETA wins. ISO dates compare correctly as strings. Ties keep insertion order
 * (Array.prototype.sort is stable).
 */
export function allocationOrder(a: Batch, b: Batch): number {
  if (a.eta === b.eta) return 0;
  if (a.eta === null) return -1;
  if (b.eta === null) return 1;
  return a.eta < b.eta ? -1 : 1;
}

/**
 * The Product aggregate: the consistency boundary for allocation. Every rule
 * that spans batches (which batch gets a line, never over-allocating a SKU)
 * is enforced here, so persisting one Product atomically is enough to keep
 * the invariants.
 */
export class Product {
  readonly sku: string;
  readonly batches: Batch[];

  constructor(sku: string, batches: Batch[] = []) {
    this.sku = sku;
    this.batches = batches;
  }

  static fromState(state: ProductState): Product {
    return new Product(state.sku, state.batches.map(Batch.fromState));
  }

  toState(): ProductState {
    return { sku: this.sku, batches: this.batches.map((b) => b.toState()) };
  }

  addBatch(reference: string, qty: number, eta: string | null = null): Batch {
    if (this.batches.some((b) => b.reference === reference)) {
      throw new DuplicateBatch(reference);
    }
    const batch = new Batch(reference, this.sku, qty, eta);
    this.batches.push(batch);
    return batch;
  }

  /** The batch already holding this exact line, if any. */
  allocationOf(line: OrderLine): Batch | undefined {
    return this.batches.find((b) => b.holds(line));
  }

  /**
   * Allocates the line to the preferred batch that can take it and returns
   * that batch's reference. A line that is already allocated keeps its batch.
   */
  allocate(line: OrderLine): string {
    if (line.sku !== this.sku) throw new SkuMismatch(this.sku, line.sku);
    const existing = this.allocationOf(line);
    if (existing) return existing.reference;
    const batch = [...this.batches].sort(allocationOrder).find((b) =>
      b.canAllocate(line)
    );
    if (!batch) {
      const available = Math.max(
        0,
        ...this.batches.map((b) => b.availableQuantity),
      );
      throw new OutOfStock(this.sku, line.qty, available);
    }
    batch.allocate(line);
    return batch.reference;
  }

  get availableQuantity(): number {
    return this.batches.reduce((sum, b) => sum + b.availableQuantity, 0);
  }
}
