// The demo "other system" for Cosmic Python chapter 11, events out: it takes
// the allocation events the Stock app's behavior posts, checks their
// signature and shows them on a page. Node built-ins only.
//
// POST /events  JSON event, signed as X-Puddleworks-Signature: sha256=<hex
//               HMAC-SHA256 of the raw body> with STOCK_EVENTS_SECRET. 204 when
//               stored, 401 on a bad signature, repeats (same id) ignored.
// GET  /        the received events, newest first.
// GET  /health  200.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const secret = process.env.STOCK_EVENTS_SECRET ?? "";
const dataDir = process.env.AMP_DEPLOYMENT_DATA_DIRECTORY ?? "./data";
const logFile = join(dataDir, "events.jsonl");
const MAX_BODY = 64 * 1024;

mkdirSync(dataDir, { recursive: true });

function readEvents() {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const seen = new Set(readEvents().map((e) => e.id));

export function validSignature(body, header, key) {
  if (!key || typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", key).update(body).digest();
  const received = Buffer.from(header.slice(7), "hex");
  return received.length === expected.length &&
    timingSafeEqual(received, expected);
}

const escape = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PILL = { Allocated: "ok", Deallocated: "warn", OutOfStock: "alert" };

function page(events) {
  const rows = events.slice().reverse().map((e) => `
      <tr>
        <td>${escape(e.receivedAt?.slice(0, 19).replace("T", " "))}</td>
        <td><span class="pill ${PILL[e.type] ?? "muted"}">${escape(e.type)}</span></td>
        <td>${escape(e.orderid)}</td><td>${escape(e.sku)}</td>
        <td class="num">${escape(e.qty)}</td><td>${e.type === "OutOfStock" ? `<span class="note">none free (largest ${escape(e.available)})</span>` : escape(e.batchref)}</td>
      </tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Stock events</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f7f9; --surface:#fff; --text:#0f1219; --muted:#5f6879; --border:#d8dee6; --accent:#13707c; --accent-subtle:#e6f6f8; --danger:#b91c1c; --alert:#92400e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1219; --surface:#1c2233; --text:#e8ecf1; --muted:#8a94aa; --border:#262d40; --accent:#5ec4d4; --accent-subtle:#15303a; --danger:#fca5a5; --alert:#fcd34d; } }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--text); font:15px/1.5 Inter, system-ui, sans-serif; }
  .brand { font-weight:600; font-size:1.1rem; } .brand b { color:var(--accent); }
  h1 { font-size:1.375rem; margin:.75rem 0 .25rem; } p { color:var(--muted); margin:0 0 1.25rem; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.25rem; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:.55rem .5rem; border-bottom:1px solid var(--border); }
  th { font-size:.75rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); } .num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { padding:.1rem .55rem; border-radius:999px; font-size:.8rem; border:1px solid; }
  .ok { color:var(--accent); background:var(--accent-subtle); } .warn { color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, var(--surface)); }
  .alert { color:var(--alert); background:color-mix(in srgb, var(--alert) 12%, var(--surface)); } .muted { color:var(--muted); } .note { color:var(--muted); }
  .empty { color:var(--muted); padding:1rem .5rem; }
</style></head>
<body>
  <div class="brand">puddle <b>works</b></div>
  <h1>Stock events</h1>
  <p>A demo of another system receiving the Stock app's signed allocation events, delivered by Swamp's scheduled dispatch (about once a minute). ${events.length} received${secret ? "" : " · STOCK_EVENTS_SECRET is not set, so new events are refused"}. Refreshes every 10 s.</p>
  <div class="card"><table>
    <thead><tr><th>Received (UTC)</th><th>Event</th><th>Order</th><th>SKU</th><th class="num">Qty</th><th>Batch</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">No events yet.</td></tr>'}</tbody>
  </table></div>
</body></html>`;
}

function send(res, status, body = "", type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/health") return send(res, 200, "ok");
  if (req.method === "GET" && path === "/") {
    return send(res, 200, page(readEvents()), "text/html; charset=utf-8");
  }
  if (req.method !== "POST" || path !== "/events") return send(res, 404, "not found");

  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (!validSignature(body, req.headers["x-puddleworks-signature"], secret)) {
      return send(res, 401, "invalid signature");
    }
    let event;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      return send(res, 400, "body is not JSON");
    }
    if (typeof event.id !== "string") return send(res, 400, "event has no id");
    if (!seen.has(event.id)) {
      seen.add(event.id);
      appendFileSync(
        logFile,
        JSON.stringify({ ...event, receivedAt: new Date().toISOString() }) + "\n",
      );
    }
    send(res, 204);
  });
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, "0.0.0.0", () => console.log(`stock-events listening on ${port}`));
