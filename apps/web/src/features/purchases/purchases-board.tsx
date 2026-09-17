'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, Plus, Send, Truck, X } from 'lucide-react';
import { loadOptions } from '@/lib/pagination';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { components } from '@/generated/api-schema';

type Supplier = components['schemas']['SupplierResponse'];
type Order = components['schemas']['PurchaseOrderResponse'];
type Product = Pick<
  components['schemas']['PurchaseProductResponse'],
  'id' | 'sku' | 'name' | 'costPrice' | 'tracksBatches'
>;
async function load<T>(resource: string) {
  const response = await sessionFetch(`/api/purchases?resource=${resource}`);
  const body = (await response.json()) as { data?: T; detail?: string };
  if (!response.ok) throw new Error(body.detail ?? 'No pudimos cargar compras.');
  return body.data as T;
}
export function PurchasesBoard() {
  const client = useQueryClient();
  const { can } = useAccess();
  const [tab, setTab] = useState<'orders' | 'suppliers'>('orders');
  const [modal, setModal] = useState<'supplier' | 'order' | null>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [message, setMessage] = useState('');
  const orders = useQuery({ queryKey: ['purchases'], queryFn: () => load<Order[]>('orders') });
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => load<Supplier[]>('suppliers'),
    enabled: can('suppliers.read'),
  });
  const products = useQuery({
    queryKey: ['purchase-products'],
    queryFn: ({ signal }) => loadOptions<Product>('/api/purchases?resource=products', signal),
    enabled: modal === 'order' && can('products.read'),
  });
  const refresh = async () => {
    setModal(null);
    setReceipt(null);
    await Promise.all([
      client.invalidateQueries({ queryKey: ['purchases'] }),
      client.invalidateQueries({ queryKey: ['suppliers'] }),
      client.invalidateQueries({ queryKey: ['products'] }),
    ]);
  };
  async function action(order: Order, name: 'submit') {
    const response = await sessionFetch(`/api/purchases?id=${order.id}&action=${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      const body = (await response.json()) as { detail?: string };
      setMessage(body.detail ?? 'No pudimos actualizar la orden.');
      return;
    }
    await refresh();
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Abastecimiento</p>
          <h1 className="font-display text-4xl font-semibold">Compras y proveedores</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Órdenes conectadas con stock, costo promedio y Kardex.
          </p>
        </div>
        <div className="flex gap-2">
          <Can permission="suppliers.create">
            <Button variant="outline" onClick={() => setModal('supplier')}>
              <Plus size={17} />
              Proveedor
            </Button>
          </Can>
          <Can permission="purchases.create">
            <Button onClick={() => setModal('order')}>
              <Plus size={17} />
              Orden
            </Button>
          </Can>
        </div>
      </div>
      <div className="flex rounded-xl bg-muted p-1 sm:w-fit">
        {(
          [
            ['orders', 'Órdenes'],
            ['suppliers', 'Proveedores'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`min-h-10 rounded-lg px-5 text-sm font-semibold ${tab === key ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {(orders.error || suppliers.error || products.error) && (
        <p role="alert">No se pudieron cargar las compras o sus opciones.</p>
      )}
      {orders.isPending && <p role="status">Cargando compras…</p>}
      {message && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {message}
        </p>
      )}
      {tab === 'orders' ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                {['Orden', 'Proveedor', 'Fecha', 'Estado', 'Total', 'Acciones'].map((x) => (
                  <th className="p-4" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {orders.data?.map((o) => (
                <tr key={o.id}>
                  <td className="p-4 font-bold">{o.number}</td>
                  <td className="p-4">{o.supplier?.name ?? 'Proveedor no disponible'}</td>
                  <td className="p-4">{new Date(o.createdAt).toLocaleDateString('es-GT')}</td>
                  <td className="p-4">
                    <span className="rounded-full bg-secondary px-2 py-1 text-xs font-bold">
                      {o.status}
                    </span>
                  </td>
                  <td className="p-4 font-bold">Q {Number(o.total).toFixed(2)}</td>
                  <td className="p-4">
                    <div className="flex gap-2">
                      {o.status === 'DRAFT' && (
                        <Can permission="purchases.submit">
                          <Button variant="outline" onClick={() => action(o, 'submit')}>
                            <Send size={15} />
                            Enviar
                          </Button>
                        </Can>
                      )}
                      {['SUBMITTED', 'PARTIALLY_RECEIVED'].includes(o.status) && (
                        <Can permission="purchases.receive">
                          <Button onClick={() => setReceipt(o)}>
                            <PackageCheck size={15} />
                            Recibir
                          </Button>
                        </Can>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {suppliers.data?.map((s) => (
            <Card className="p-5" key={s.id}>
              <p className="text-xs font-bold text-primary">{s.code}</p>
              <h2 className="mt-1 text-lg font-semibold">{s.name}</h2>
              <p className="mt-3 text-sm text-muted-foreground">
                {s.email ?? 'Sin correo'}
                <br />
                {s.phone ?? 'Sin teléfono'}
              </p>
              <p className="mt-3 text-xs">Crédito: {s.paymentTermDays ?? 0} días</p>
            </Card>
          ))}
        </div>
      )}
      {modal && (
        <CreateForm
          type={modal}
          suppliers={suppliers.data ?? []}
          products={products.data ?? []}
          close={() => setModal(null)}
          saved={refresh}
        />
      )}{' '}
      {receipt && <ReceiptForm order={receipt} close={() => setReceipt(null)} saved={refresh} />}
    </div>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useDialog(close);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Compras"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center sm:p-6"
    >
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl">
        <div className="mb-5 flex justify-between">
          <h2 className="font-display text-2xl font-semibold">{title}</h2>
          <button onClick={close} aria-label="Cerrar">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function CreateForm({
  type,
  suppliers,
  products,
  close,
  saved,
}: {
  type: 'supplier' | 'order';
  suppliers: Supplier[];
  products: Product[];
  close: () => void;
  saved: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const body:
      components['schemas']['CreateSupplierDto'] | components['schemas']['CreatePurchaseOrderDto'] =
      type === 'supplier'
        ? {
            code: String(form.get('code')),
            name: String(form.get('name')),
            email: form.get('email') ? String(form.get('email')) : undefined,
            phone: form.get('phone') ? String(form.get('phone')) : undefined,
            paymentTermDays: Number(form.get('paymentTermDays')),
          }
        : {
            supplierId: String(form.get('supplierId')),
            expectedAt: form.get('expectedAt')
              ? new Date(String(form.get('expectedAt'))).toISOString()
              : undefined,
            lines: [
              {
                productId: String(form.get('productId')),
                quantity: Number(form.get('quantity')),
                unitCost: Number(form.get('unitCost')),
              },
            ],
          };
    const response = await sessionFetch(`/api/purchases?resource=${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const problem = (await response.json()) as {
        detail?: string;
        errors?: { message: string }[];
      };
      setError(
        problem.errors?.map((x) => x.message).join('. ') ?? problem.detail ?? 'No pudimos guardar.',
      );
      return;
    }
    await saved();
  }
  const field = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
  return (
    <Dialog title={type === 'supplier' ? 'Nuevo proveedor' : 'Nueva orden'} close={close}>
      <form onSubmit={submit} className="space-y-4">
        {type === 'supplier' ? (
          <>
            {[
              ['code', 'Código'],
              ['name', 'Nombre'],
              ['email', 'Correo'],
              ['phone', 'Teléfono'],
            ].map(([name, label]) => (
              <label className="block text-sm font-semibold" key={name}>
                {label}
                <input
                  required={['code', 'name'].includes(name)}
                  name={name}
                  type={name === 'email' ? 'email' : 'text'}
                  className={field}
                />
              </label>
            ))}
            <label className="block text-sm font-semibold">
              Días de crédito
              <input
                required
                name="paymentTermDays"
                type="number"
                min="0"
                defaultValue="30"
                className={field}
              />
            </label>
          </>
        ) : (
          <>
            <label className="block text-sm font-semibold">
              Proveedor
              <select required name="supplierId" className={field}>
                <option value="">Selecciona…</option>
                {suppliers.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Producto
              <select
                required
                name="productId"
                className={field}
                onChange={(e) => {
                  const p = products.find((x) => x.id === e.target.value);
                  const input = e.currentTarget.form?.elements.namedItem(
                    'unitCost',
                  ) as HTMLInputElement | null;
                  if (input && p) input.value = p.costPrice;
                }}
              >
                <option value="">Selecciona…</option>
                {products.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.sku} · {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Cantidad
              <input
                required
                name="quantity"
                type="number"
                min="0.001"
                step="0.001"
                className={field}
              />
            </label>
            <label className="block text-sm font-semibold">
              Costo unitario (Q)
              <input required name="unitCost" type="number" min="0" step="0.01" className={field} />
            </label>
            <label className="block text-sm font-semibold">
              Entrega esperada
              <input name="expectedAt" type="datetime-local" className={field} />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>
    </Dialog>
  );
}
function ReceiptForm({
  order,
  close,
  saved,
}: {
  order: Order;
  close: () => void;
  saved: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const lines: components['schemas']['ReceiptLineDto'][] = order.lines
      .filter((x) => Number(x.receivedQuantity) < Number(x.quantity))
      .map((x) => ({
        lineId: x.id,
        quantity: Number(Number(f.get(`quantity-${x.id}`)).toFixed(3)),
        batchNumber: String(f.get(`batch-${x.id}`) || '') || undefined,
        expiresAt: String(f.get(`expiry-${x.id}`) || '') || undefined,
      }))
      .filter((line) => line.quantity > 0);
    if (!lines.length) {
      setError('Indica al menos una cantidad a recibir.');
      setBusy(false);
      return;
    }
    const r = await sessionFetch(`/api/purchases?id=${order.id}&action=receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    });
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json()) as { detail?: string; errors?: { message: string }[] };
      setError(p.errors?.map((x) => x.message).join('. ') ?? p.detail ?? 'No pudimos recibir.');
      return;
    }
    await saved();
  }
  return (
    <Dialog title={`Recibir ${order.number}`} close={close}>
      <form onSubmit={submit} className="space-y-4">
        {order.lines
          .filter((x) => Number(x.receivedQuantity) < Number(x.quantity))
          .map((x) => {
            const pending =
              Math.round((Number(x.quantity) - Number(x.receivedQuantity)) * 1000) / 1000;
            return (
              <fieldset className="rounded-xl border p-4" key={x.id}>
                <legend className="px-2 font-semibold">
                  {x.product?.name ?? 'Producto no disponible'}
                </legend>
                <p className="mb-2 text-xs text-muted-foreground">Pendiente: {pending}</p>
                <input
                  required
                  aria-label={'Cantidad de ' + (x.product?.name ?? 'producto')}
                  name={`quantity-${x.id}`}
                  type="number"
                  min="0"
                  max={pending}
                  step="0.001"
                  defaultValue={pending}
                  className="h-11 w-full rounded-xl border bg-background px-3"
                />
                {x.product?.tracksBatches && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <input
                      aria-label={'Lote de ' + (x.product?.name ?? 'producto')}
                      name={`batch-${x.id}`}
                      placeholder="Número de lote"
                      className="h-11 rounded-xl border bg-background px-3"
                    />
                    <input
                      aria-label={'Vencimiento de ' + (x.product?.name ?? 'producto')}
                      name={`expiry-${x.id}`}
                      type="date"
                      className="h-11 rounded-xl border bg-background px-3"
                    />
                  </div>
                )}
              </fieldset>
            );
          })}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" disabled={busy}>
          <Truck size={17} />
          {busy ? 'Recibiendo…' : 'Confirmar recepción'}
        </Button>
      </form>
    </Dialog>
  );
}
