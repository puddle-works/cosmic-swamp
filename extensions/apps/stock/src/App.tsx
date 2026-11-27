import { useDataChanges, useMethodRun, useRequest, useSwamp } from "@swamp-club/app-sdk/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@swamp-club/ui";
import { type FormEvent, useEffect, useState } from "react";
import {
  ALLOCATIONS_QUERY,
  allocationRows,
  BEHAVIOR,
  batchInputs,
  batchRows,
  orderInputs,
  PRODUCTS_QUERY,
  totalsBySku,
} from "./stock/stock.ts";

/** The Puddle Works mark, drawn in the current colour (the brand accent). */
function PuddleMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="7" r="3" fill="currentColor" />
      <ellipse cx="16" cy="19" rx="5" ry="2.25" fill="currentColor" />
      <ellipse cx="16" cy="19" rx="9" ry="4.5" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <ellipse cx="16" cy="19" rx="14" ry="7" stroke="currentColor" strokeWidth="1" opacity="0.25" />
    </svg>
  );
}

function Field(
  { id, label, value, onChange, placeholder }: {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  },
) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="pw-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function App() {
  const { app, connected } = useSwamp();
  const products = useRequest("data.query", { predicate: PRODUCTS_QUERY, limit: 500 });
  const allocations = useRequest("data.query", { predicate: ALLOCATIONS_QUERY, limit: 500 });
  const { version } = useDataChanges({ behaviors: [BEHAVIOR] });
  const { refetch: refetchProducts } = products;
  const { refetch: refetchAllocations } = allocations;
  useEffect(() => {
    if (version > 0) {
      refetchProducts();
      refetchAllocations();
    }
  }, [version, refetchProducts, refetchAllocations]);

  const method = useMethodRun();
  const [batch, setBatch] = useState({ ref: "", sku: "", qty: "", eta: "" });
  const [order, setOrder] = useState({ orderid: "", sku: "", qty: "" });
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const rows = batchRows(products.data?.data.results.map((r) => r.content) ?? []);
  const allocs = allocationRows(allocations.data?.data.results.map((r) => r.content) ?? []);
  const writable = !app.local;

  async function call(methodName: string, inputs: Record<string, unknown>) {
    await method.run({ modelIdOrName: BEHAVIOR, methodName, inputs });
  }

  async function submitBatch(e: FormEvent) {
    e.preventDefault();
    const parsed = batchInputs(batch);
    if ("error" in parsed) return setMessage({ kind: "error", text: parsed.error });
    try {
      await call("add_batch", parsed.inputs);
      setMessage({ kind: "ok", text: `Added batch ${parsed.inputs.ref}` });
      setBatch({ ref: "", sku: "", qty: "", eta: "" });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function submitOrder(e: FormEvent) {
    e.preventDefault();
    const parsed = orderInputs(order);
    if ("error" in parsed) return setMessage({ kind: "error", text: parsed.error });
    const { orderid, sku } = parsed.inputs;
    try {
      await call("create_order_line", parsed.inputs);
      await call("allocate", { orderid, sku });
      setMessage({ kind: "ok", text: `Allocated order ${orderid}` });
      setOrder({ orderid: "", sku: "", qty: "" });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pw-header flex items-center justify-between">
        <div className="pw-brand">
          <PuddleMark />
          <span className="pw-brand-name">
            puddle <span className="pw-brand-accent">works</span>
          </span>
        </div>
        <Badge className={connected ? "pw-pill" : "pw-pill pw-pill--muted"}>
          {connected ? "Connected" : "Reconnecting"}
        </Badge>
      </header>
      <h1 className="pw-title">{app.title}</h1>

      {!writable && (
        <Alert>
          <AlertDescription>
            The local dashboard is read-only. Run <code>swamp serve --dashboard</code> to add batches and allocate.
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert
          role="status"
          className={message.kind === "error" ? "pw-notice pw-notice--error" : "pw-notice pw-notice--ok"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <Card className="pw-card">
          <CardHeader>
            <CardTitle className="pw-label">Add batch</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-3" onSubmit={submitBatch}>
              <Field id="b-ref" label="Reference" value={batch.ref} onChange={(ref) => setBatch({ ...batch, ref })} />
              <Field id="b-sku" label="SKU" value={batch.sku} onChange={(sku) => setBatch({ ...batch, sku })} />
              <Field id="b-qty" label="Quantity" value={batch.qty} onChange={(qty) => setBatch({ ...batch, qty })} />
              <Field
                id="b-eta"
                label="Arrives (optional)"
                placeholder="YYYY-MM-DD"
                value={batch.eta}
                onChange={(eta) => setBatch({ ...batch, eta })}
              />
              <Button type="submit" disabled={!writable || method.running} className="col-span-2">
                Add batch
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card className="pw-card">
          <CardHeader>
            <CardTitle className="pw-label">Allocate order line</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-3" onSubmit={submitOrder}>
              <Field
                id="o-id"
                label="Order"
                value={order.orderid}
                onChange={(orderid) => setOrder({ ...order, orderid })}
              />
              <Field id="o-sku" label="SKU" value={order.sku} onChange={(sku) => setOrder({ ...order, sku })} />
              <Field id="o-qty" label="Quantity" value={order.qty} onChange={(qty) => setOrder({ ...order, qty })} />
              <Button type="submit" disabled={!writable || method.running} className="col-span-2">
                Allocate
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      <Card className="pw-card">
        <CardHeader>
          <CardTitle className="pw-label">Available stock</CardTitle>
        </CardHeader>
        <CardContent>
          {products.error && <p className="text-sm text-destructive">{String(products.error)}</p>}
          <div className="mb-3 flex flex-wrap gap-2">
            {totalsBySku(rows).map((t) => <Badge key={t.sku} className={t.available > 0 ? "pw-pill" : "pw-pill pw-pill--muted"}>
                {t.sku}: {t.available} available
              </Badge>)}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Arrives</TableHead>
                <TableHead className="text-right">Purchased</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Available</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.sku}/${r.reference}`}>
                  <TableCell>{r.sku}</TableCell>
                  <TableCell>{r.reference}</TableCell>
                  <TableCell>{r.eta ?? "In warehouse"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.purchased}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.allocated}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.available}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="pw-card">
        <CardHeader>
          <CardTitle className="pw-label">Allocations</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Batch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocs.map((a) => (
                <TableRow key={`${a.orderid}/${a.sku}`}>
                  <TableCell>{a.orderid}</TableCell>
                  <TableCell>{a.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.qty}</TableCell>
                  <TableCell>{a.batchref}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </main>
  );
}
