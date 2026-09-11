'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Boxes, PackageCheck, PackageX, Plus, Search, Truck, X } from 'lucide-react';
import { usePagedList } from '@/lib/use-paged-list';
import { loadOptions } from '@/lib/pagination';
import { Pagination } from '@/components/ui/pagination';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
type Product = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  price: string;
  costPrice: string;
  currency: string;
  stockOnHand: string;
  reorderPoint: string;
  reorderQuantity: string;
  stockStatus: 'AVAILABLE' | 'LOW' | 'OUT';
};
type Move = {
  id: string;
  type: string;
  quantityDelta: string;
  balanceAfter: string;
  occurredAt: string;
  reason: string | null;
  product: { sku: string; name: string };
  batch: { batchNumber: string } | null;
};
type Batch = {
  id: string;
  batchNumber: string;
  expiresAt: string | null;
  remainingQuantity: string;
  unitCost: string;
  product: { sku: string; name: string };
};
export function InventoryBoard() {
  const qc = useQueryClient();
  const { can } = useAccess();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'stock' | 'kardex' | 'batches'>('stock');
  const [action, setAction] = useState<'product' | 'receive' | 'adjust' | null>(null);
  const products = usePagedList<Product>(
    'products',
    '/api/inventory?resource=products&limit=20&page=' +
      page +
      '&search=' +
      encodeURIComponent(search),
    tab === 'stock',
  );
  const moves = usePagedList<Move>(
    'kardex',
    '/api/inventory?resource=kardex&limit=20&page=' + page,
    tab === 'kardex' && can('inventory.read'),
  );
  const batches = usePagedList<Batch>(
    'batches',
    '/api/inventory?resource=batches&limit=20&page=' +
      page +
      '&search=' +
      encodeURIComponent(search),
    tab === 'batches' && can('inventory.read'),
  );
  const options = useQuery({
    queryKey: ['inventory-options'],
    queryFn: ({ signal }) => loadOptions<Product>('/api/inventory?resource=products', signal),
    enabled: action === 'receive' || action === 'adjust',
  });
  const active = tab === 'stock' ? products : tab === 'kardex' ? moves : batches;
  const filtered = products.data ?? [];
  const groups = [
    { key: 'AVAILABLE', label: 'Disponible', icon: PackageCheck, tone: 'text-success' },
    { key: 'LOW', label: 'Bajo', icon: AlertTriangle, tone: 'text-warning' },
    { key: 'OUT', label: 'Agotado', icon: PackageX, tone: 'text-danger' },
  ] as const;
  const refresh = async () => {
    setAction(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['products'] }),
      qc.invalidateQueries({ queryKey: ['kardex'] }),
      qc.invalidateQueries({ queryKey: ['batches'] }),
      qc.invalidateQueries({ queryKey: ['inventory-options'] }),
    ]);
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Existencias</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Inventario</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Stock, lotes y trazabilidad en tiempo real.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Can permission="inventory.adjust">
            <Button variant="outline" onClick={() => setAction('adjust')}>
              <Boxes size={17} />
              Ajustar
            </Button>
          </Can>
          <Can permission="inventory.receive">
            <Button variant="outline" onClick={() => setAction('receive')}>
              <Truck size={17} />
              Recibir
            </Button>
          </Can>
          <Can permission="products.create">
            <Button onClick={() => setAction('product')}>
              <Plus size={17} />
              Producto
            </Button>
          </Can>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex rounded-xl bg-muted p-1">
          {(
            [
              ['stock', 'Stock'],
              ['kardex', 'Kardex'],
              ['batches', 'Lotes'],
            ] as const
          )
            .filter(([k]) => k === 'stock' || can('inventory.read'))
            .map(([k, l]) => (
              <button
                key={k}
                onClick={() => {
                  setTab(k);
                  setPage(1);
                }}
                className={`min-h-10 rounded-lg px-4 text-sm font-semibold ${tab === k ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
              >
                {l}
              </button>
            ))}
        </div>
        <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border bg-card px-3">
          <Search size={17} />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Buscar producto"
            placeholder="Buscar producto…"
          />
        </label>
      </div>
      {tab === 'stock' && (
        <div className="grid gap-4 xl:grid-cols-3">
          {groups.map((g) => (
            <section key={g.key} className="rounded-2xl bg-muted/60 p-3">
              <h2 className="mb-3 flex items-center gap-2 px-1 font-semibold">
                <g.icon className={g.tone} size={19} />
                {g.label}
                <span className="ml-auto rounded-full bg-card px-2 py-1 text-xs">
                  {filtered.filter((p) => p.stockStatus === g.key).length}
                </span>
              </h2>
              <div className="space-y-3">
                {filtered
                  .filter((p) => p.stockStatus === g.key)
                  .map((p) => (
                    <Card key={p.id} className="p-4">
                      <div className="flex justify-between gap-3">
                        <div>
                          <p className="font-semibold">{p.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {p.sku} · {p.brand ?? 'Sin marca'}
                          </p>
                        </div>
                        <p className="text-xl font-bold">{Number(p.stockOnHand)}</p>
                      </div>
                      <div className="mt-4 flex justify-between border-t pt-3 text-xs text-muted-foreground">
                        <span>Mínimo {Number(p.reorderPoint)}</span>
                        <span>
                          {p.price} {p.currency}
                        </span>
                      </div>
                    </Card>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {tab === 'kardex' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                {['Fecha', 'Producto', 'Movimiento', 'Cantidad', 'Saldo', 'Motivo'].map((x) => (
                  <th key={x} className="p-4">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {moves.data?.map((m) => (
                <tr key={m.id}>
                  <td className="p-4">{new Date(m.occurredAt).toLocaleString('es-GT')}</td>
                  <td className="p-4 font-semibold">
                    {m.product.name}
                    <small className="block font-normal text-muted-foreground">
                      {m.product.sku}
                    </small>
                  </td>
                  <td className="p-4">{m.type}</td>
                  <td
                    className={`p-4 font-bold ${Number(m.quantityDelta) >= 0 ? 'text-success' : 'text-danger'}`}
                  >
                    {Number(m.quantityDelta) > 0 ? '+' : ''}
                    {Number(m.quantityDelta)}
                  </td>
                  <td className="p-4">{Number(m.balanceAfter)}</td>
                  <td className="p-4">{m.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'batches' && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {batches.data?.map((b) => (
            <Card key={b.id} className="p-5">
              <p className="text-xs text-muted-foreground">{b.product.sku}</p>
              <h2 className="mt-1 font-semibold">{b.product.name}</h2>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <span>
                  Lote<strong className="block">{b.batchNumber}</strong>
                </span>
                <span>
                  Disponible<strong className="block">{Number(b.remainingQuantity)}</strong>
                </span>
                <span className="col-span-2">
                  Vence
                  <strong className="block">
                    {b.expiresAt
                      ? new Date(b.expiresAt).toLocaleDateString('es-GT')
                      : 'Sin vencimiento'}
                  </strong>
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
      {active.isPending && <p role="status">Cargando inventario…</p>}
      {active.error && (
        <p role="alert">
          No se pudo cargar el inventario.{' '}
          <button onClick={() => active.refetch()}>Reintentar</button>
        </p>
      )}
      <Pagination meta={active.meta} pending={active.isFetching} onPage={setPage} />
      {action && (
        <InventoryForm
          action={action}
          products={options.data ?? []}
          onClose={() => setAction(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
function InventoryForm({
  action,
  products,
  onClose,
  onSaved,
}: {
  action: 'product' | 'receive' | 'adjust';
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> =
      action === 'product'
        ? {
            // El dominio solo admite letras, dígitos, punto, guion y guion bajo (y debe
            // empezar por letra o dígito). Normalizamos aquí lo que teclee la persona
            // usuaria para que un espacio o un acento no acaben en un 400 confuso.
            sku: String(f.get('sku') ?? '')
              .trim()
              .toUpperCase()
              .replace(/[^A-Z0-9._-]+/g, '-')
              .replace(/^-+/, ''),
            name: f.get('name'),
            brand: f.get('brand') || undefined,
            price: Number(f.get('price')),
            costPrice: Number(f.get('costPrice')),
            reorderPoint: Number(f.get('reorderPoint')),
            reorderQuantity: Number(f.get('reorderQuantity')),
          }
        : action === 'receive'
          ? {
              productId: f.get('productId'),
              quantity: Number(f.get('quantity')),
              unitCost: Number(f.get('unitCost')),
              batchNumber: f.get('batchNumber') || undefined,
              expiresAt: f.get('expiresAt') || undefined,
            }
          : {
              productId: f.get('productId'),
              quantityDelta: Number(f.get('quantityDelta')),
              reason: f.get('reason'),
              type: Number(f.get('quantityDelta')) < 0 ? 'WASTE_OUT' : 'ADJUSTMENT',
            };
    const r = await sessionFetch(
      `/api/inventory?resource=${action === 'product' ? 'products' : action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json()) as { detail?: string };
      setError(p.detail ?? 'No pudimos guardar el movimiento.');
      return;
    }
    onSaved();
  }
  const input = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Inventario"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center"
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between">
          <h2 className="font-display text-2xl font-semibold">
            {action === 'product'
              ? 'Nuevo producto'
              : action === 'receive'
                ? 'Recibir mercancía'
                : 'Ajustar stock'}
          </h2>
          <button type="button" onClick={onClose}>
            <X />
          </button>
        </div>
        {action === 'product' ? (
          <>
            {[
              ['sku', 'SKU'],
              ['name', 'Nombre'],
              ['brand', 'Marca'],
              ['price', 'Precio de venta'],
              ['costPrice', 'Costo'],
              ['reorderPoint', 'Stock mínimo'],
              ['reorderQuantity', 'Cantidad a reponer'],
            ].map(([n, l]) => (
              <label key={n} className="block text-sm font-semibold">
                {l}
                <input
                  required={n !== 'brand'}
                  type={
                    ['price', 'costPrice', 'reorderPoint', 'reorderQuantity'].includes(n)
                      ? 'number'
                      : 'text'
                  }
                  step="0.01"
                  name={n}
                  placeholder={n === 'sku' ? 'Ej. SH-ARG-500' : undefined}
                  className={input}
                />
                {n === 'sku' && (
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    Código corto del producto: letras, números, puntos y guiones.
                  </span>
                )}
              </label>
            ))}
          </>
        ) : (
          <>
            <label className="block text-sm font-semibold">
              Producto
              <select required name="productId" className={input}>
                <option value="">Selecciona…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({Number(p.stockOnHand)})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              {action === 'receive' ? 'Cantidad recibida' : 'Variación (+/-)'}
              <input
                required
                name={action === 'receive' ? 'quantity' : 'quantityDelta'}
                type="number"
                step="0.001"
                className={input}
              />
            </label>
            {action === 'receive' ? (
              <>
                <label className="block text-sm font-semibold">
                  Costo unitario
                  <input required name="unitCost" type="number" step="0.01" className={input} />
                </label>
                <label className="block text-sm font-semibold">
                  Número de lote
                  <input name="batchNumber" className={input} />
                </label>
                <label className="block text-sm font-semibold">
                  Vencimiento
                  <input name="expiresAt" type="date" className={input} />
                </label>
              </>
            ) : (
              <label className="block text-sm font-semibold">
                Motivo
                <input required name="reason" className={input} />
              </label>
            )}
          </>
        )}
        {error && <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
        </div>
      </form>
    </div>
  );
}
