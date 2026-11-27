/**
 * Which stored events still need delivering. Pure: the notifier behavior
 * passes in the `event` records of every allocation behavior and the event
 * ids its own `delivery` records name.
 *
 * @module
 */

/** An event as the allocation behavior stores it (spec `event`). */
export interface StoredEvent {
  id: string;
  at: string;
  type: string;
  orderid: string;
  sku: string;
  qty: number;
  batchref?: string;
  available?: number;
}

const isStoredEvent = (v: unknown): v is StoredEvent => {
  const e = v as Record<string, unknown> | null;
  return !!e && typeof e.id === "string" && typeof e.at === "string" &&
    typeof e.type === "string" && typeof e.orderid === "string" &&
    typeof e.sku === "string" && typeof e.qty === "number";
};

/**
 * Undelivered events, oldest first, at most `limit`. Delivering in order
 * and stopping at the first failure keeps a receiver's view in order.
 */
export function pendingEvents(
  events: unknown[],
  deliveredIds: Iterable<unknown>,
  limit: number,
): StoredEvent[] {
  const delivered = new Set(deliveredIds);
  return events
    .filter(isStoredEvent)
    .filter((e) => !delivered.has(e.id))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
