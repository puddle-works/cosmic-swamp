/**
 * Sends allocation events to another system over HTTP (the book's chapter 11,
 * events out). Swamp has no outbound event stream, so the behavior posts each
 * event itself once the command's writes are done.
 *
 * Each event is one POST of JSON, signed like the incoming order webhook:
 * `X-Puddleworks-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. The
 * `id` lets a receiver drop a repeat.
 *
 * @module
 */

import type { AllocationEvent } from "./service.ts";

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
  event: AllocationEvent,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  });
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
