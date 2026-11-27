/**
 * Posts a stored event to another system over HTTP (the book's chapter 11,
 * events out). Each event is one POST of JSON, signed like the incoming order
 * webhook: `X-Puddleworks-Signature: sha256=<hex HMAC-SHA256 of the raw
 * body>`. The event's `id` was fixed when it was saved, so a receiver can
 * drop a repeat: delivery is at least once.
 *
 * @module
 */

import type { StoredEvent } from "./outbox.ts";

export async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Posts one event; throws when the receiver does not answer 2xx within 5 s. */
export async function sendEvent(
  url: string,
  secret: string,
  event: StoredEvent,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify(event);
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-puddleworks-signature": `sha256=${await sign(body, secret)}`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
}
