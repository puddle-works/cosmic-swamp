/**
 * `@puddleworks/notifier`: delivers the allocation behavior's domain events
 * to another system (ADR 0007). Swamp is the message bus: commands save
 * events as data in the run that made the change, and the
 * `@puddleworks/dispatch-events` workflow runs `dispatch` every minute on
 * serve's scheduler.
 *
 * `dispatch` posts each undelivered event, oldest first, to STOCK_EVENTS_URL,
 * signed with STOCK_EVENTS_SECRET, and records a `delivery-<event id>` for
 * each one the receiver accepted. It stops at the first failure; the rest
 * stay pending and are retried on the next run. A crash between a send and
 * its delivery record resends that event, so receivers drop repeats by id.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { sendEvent } from "./event_sender.ts";
import { pendingEvents } from "./outbox.ts";

const EVENTS_QUERY =
  'modelType == "@puddleworks/allocation" && specName == "event"';

const DispatchArgs = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100).describe(
    "Most events to deliver in one run",
  ),
});

type Log = (msg: string, properties?: Record<string, unknown>) => void;
interface Context {
  modelId: string;
  logger: { info: Log; warn: Log };
  queryData?: (predicate: string) => Promise<unknown[]>;
  writeResource?: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string; version: number }>;
}

const attributesOf = (rows: unknown[]) =>
  rows.map((r) => (r as { attributes?: unknown }).attributes);

export const behavior = {
  type: "@puddleworks/notifier",
  version: "2026.11.28.1",
  globalArguments: z.object({}),
  resources: {
    delivery: {
      description:
        "An event the receiver accepted; an event with no delivery is still pending",
      schema: z.object({
        eventId: z.string(),
        type: z.string(),
        orderid: z.string(),
        deliveredAt: z.string(),
      }),
      lifetime: "30d",
      garbageCollection: 1,
    },
  },
  methods: {
    dispatch: {
      description:
        "Deliver pending allocation events, oldest first, to STOCK_EVENTS_URL; stops at the first failure",
      kind: "update",
      arguments: DispatchArgs,
      execute: async (args: z.infer<typeof DispatchArgs>, context: Context) => {
        const { limit } = DispatchArgs.parse(args);
        const url = Deno.env.get("STOCK_EVENTS_URL");
        const secret = Deno.env.get("STOCK_EVENTS_SECRET");
        if (!url || !secret) {
          context.logger.info(
            "STOCK_EVENTS_URL or STOCK_EVENTS_SECRET is not set; nothing delivered",
          );
          return { dataHandles: [] };
        }
        const events = attributesOf(await context.queryData!(EVENTS_QUERY));
        const delivered = attributesOf(
          await context.queryData!(
            `modelId == "${context.modelId}" && specName == "delivery"`,
          ),
        ).map((d) => (d as { eventId?: unknown } | undefined)?.eventId);
        const pending = pendingEvents(events, delivered, limit);

        const dataHandles = [];
        for (const event of pending) {
          try {
            await sendEvent(url, secret, event);
          } catch (err) {
            context.logger.warn(
              "Could not deliver {type} for {orderid}: {error}; {left} left for the next run",
              {
                ...event,
                error: err instanceof Error ? err.message : String(err),
                left: pending.length - dataHandles.length,
              },
            );
            break;
          }
          dataHandles.push(
            await context.writeResource!("delivery", `delivery-${event.id}`, {
              eventId: event.id,
              type: event.type,
              orderid: event.orderid,
              deliveredAt: new Date().toISOString(),
            }),
          );
          context.logger.info("Delivered {type} for {orderid}", { ...event });
        }
        if (pending.length === 0) context.logger.info("No pending events");
        return { dataHandles };
      },
    },
  },
};
