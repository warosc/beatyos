'use client';
import { sessionFetch } from '@/lib/session-fetch';
import { Can, useAccess } from '@/components/session-access';
import { loadOptions } from '@/lib/pagination';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Minus, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
type Item = {
  id: string;
  name: string;
  price: string;
  priceWithTax?: string;
  taxRate: number;
  currency: string;
  stockOnHand?: string;
  kind: 'PRODUCT' | 'SERVICE';
};
type Client = { id: string; fullName: string };
type Cart = { item: Item; quantity: number };
type MyStylist = { id: string; displayName: string };

const lineTotal = (item: Item, quantity: number): number => {
  const subtotalInCents = Math.round(Number(item.price) * 100 * quantity);
  const taxInCents = Math.round((subtotalInCents * Number(item.taxRate)) / 100);
  return (subtotalInCents + taxInCents) / 100;
};

const money = (amount: number) =>
  new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' }).format(amount);
export function Pos() {
  const cache = useQueryClient();
  const { can } = useAccess();
  const [cart, setCart] = useState<Cart[]>([]);
  const [search, setSearch] = useState('');
  const [client, setClient] = useState('');
  const [method, setMethod] = useState('CARD');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const products = useQuery({
    queryKey: ['pos-products'],
    enabled: can('products.read'),
    queryFn: async () =>
      (await loadOptions<Omit<Item, 'kind'>>('/api/inventory?resource=products')).map((x) => ({
        ...x,
        kind: 'PRODUCT' as const,
      })),
  });
  const services = useQuery({
    queryKey: ['pos-services'],
    enabled: can('services.read'),
    queryFn: async () =>
      (await loadOptions<Omit<Item, 'kind'>>('/api/agenda?resource=services&limit=100')).map(
        (x) => ({
          ...x,
          kind: 'SERVICE' as const,
        }),
      ),
  });
  const clients = useQuery({
    queryKey: ['pos-clients'],
    enabled: can('clients.read'),
    queryFn: () => loadOptions<Client>('/api/agenda?resource=clients&limit=100&sort=name:asc'),
  });
  // Si quien cobra es una estilista, sus líneas quedan atribuidas a sí misma desde ya: es lo
  // que necesitará el informe de comisiones cuando exista, y no cuesta nada tenerlo ya bien.
  const myStylist = useQuery({
    queryKey: ['my-stylist'],
    queryFn: async () => {
      const response = await sessionFetch('/api/stylists/me');
      const body = (await response.json()) as { data: MyStylist | null };
      return body.data;
    },
  });
  const items = [...(products.data ?? []), ...(services.data ?? [])].filter((x) =>
    x.name.toLowerCase().includes(search.toLowerCase()),
  );
  const total = useMemo(
    () => cart.reduce((sum, line) => sum + lineTotal(line.item, line.quantity), 0),
    [cart],
  );
  function add(item: Item) {
    const available = item.kind === 'PRODUCT' ? Number(item.stockOnHand ?? 0) : Infinity;
    setCart((c) => {
      const old = c.find((x) => x.item.id === item.id);
      if ((old?.quantity ?? 0) >= available) {
        setNotice({ kind: 'error', text: `No hay más existencias disponibles de ${item.name}.` });
        return c;
      }
      setNotice(null);
      return old
        ? c.map((x) => (x.item.id === item.id ? { ...x, quantity: x.quantity + 1 } : x))
        : [...c, { item, quantity: 1 }];
    });
  }
  async function charge() {
    setBusy(true);
    setNotice(null);
    const r = await sessionFetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: client || undefined,
        lines: cart.map((x) => ({
          kind: x.item.kind,
          itemId: x.item.id,
          quantity: x.quantity,
          stylistId: myStylist.data?.id,
        })),
        payments: [{ method, amount: Number(total.toFixed(2)) }],
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const b = (await r.json()) as {
        detail?: string;
        message?: string;
        errors?: { message: string }[];
      };
      setNotice({
        kind: 'error',
        text:
          b.errors?.map((error) => error.message).join('. ') ??
          b.detail ??
          b.message ??
          'No pudimos procesar la venta.',
      });
      return;
    }
    const b = (await r.json()) as { data: { number: string } };
    setNotice({ kind: 'success', text: `Venta ${b.data.number} completada` });
    setCart([]);
    await cache.invalidateQueries();
  }
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
      <section className="space-y-5">
        {(products.error || services.error || clients.error) && (
          <p role="alert">
            No se pudo cargar el catálogo completo.{' '}
            <button onClick={() => cache.invalidateQueries()}>Reintentar</button>
          </p>
        )}
        <div>
          <p className="text-sm font-medium text-primary">Punto de venta</p>
          <h1 className="font-display text-4xl font-semibold">Nueva venta</h1>
        </div>
        <label className="flex h-12 items-center gap-2 rounded-xl border bg-card px-4">
          <Search />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar servicio o producto"
            placeholder="Buscar servicio o producto…"
            className="w-full bg-transparent outline-none"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <button
              key={`${item.kind}-${item.id}`}
              onClick={() => add(item)}
              disabled={item.kind === 'PRODUCT' && Number(item.stockOnHand ?? 0) <= 0}
              className="rounded-2xl border bg-card p-5 text-left transition hover:border-primary hover:shadow-md"
            >
              <span className="text-xs font-bold text-primary">
                {item.kind === 'PRODUCT' ? 'PRODUCTO' : 'SERVICIO'}
              </span>
              <h2 className="mt-2 font-semibold">{item.name}</h2>
              <p className="mt-4 text-xl font-bold">{money(lineTotal(item, 1))}</p>
              {item.stockOnHand && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Stock: {Number(item.stockOnHand)}
                </p>
              )}
            </button>
          ))}
        </div>
      </section>
      <Card className="flex h-fit min-h-[620px] flex-col p-5 xl:sticky xl:top-24">
        <h2 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <ShoppingBag />
          Ticket
        </h2>
        <select
          aria-label="Cliente de la venta"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          className="mt-5 h-11 rounded-xl border bg-background px-3 text-sm"
        >
          <option value="">Cliente ocasional</option>
          {clients.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.fullName}
            </option>
          ))}
        </select>
        <div className="my-5 flex-1 space-y-3">
          {cart.map((x) => (
            <div key={`${x.item.kind}-${x.item.id}`} className="rounded-xl bg-muted p-3">
              <div className="flex justify-between">
                <p className="font-semibold">{x.item.name}</p>
                <button onClick={() => setCart((c) => c.filter((y) => y.item.id !== x.item.id))}>
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setCart((c) =>
                        c.map((y) =>
                          y.item.id === x.item.id
                            ? { ...y, quantity: Math.max(1, y.quantity - 1) }
                            : y,
                        ),
                      )
                    }
                    className="grid size-8 place-items-center rounded-lg bg-card"
                  >
                    <Minus size={14} />
                  </button>
                  <span>{x.quantity}</span>
                  <button
                    onClick={() => add(x.item)}
                    className="grid size-8 place-items-center rounded-lg bg-card"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <strong>{money(lineTotal(x.item, x.quantity))}</strong>
              </div>
            </div>
          ))}
          {!cart.length && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Selecciona productos o servicios.
            </p>
          )}
        </div>
        <div className="border-t pt-4">
          <div className="flex justify-between text-xl font-bold">
            <span>Total</span>
            <span>{money(total)}</span>
          </div>
          <select
            aria-label="Método de pago"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="my-4 h-11 w-full rounded-xl border bg-background px-3"
          >
            <option value="CARD">Tarjeta</option>
            <option value="CASH">Efectivo</option>
            <option value="TRANSFER">Transferencia</option>
          </select>
          {notice && (
            <p
              role={notice.kind === 'error' ? 'alert' : 'status'}
              className={`mb-3 flex items-start gap-2 rounded-xl p-3 text-sm ${notice.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-secondary'}`}
            >
              {notice.kind === 'error' && <AlertCircle className="mt-0.5 shrink-0" size={16} />}
              {notice.text}
            </p>
          )}
          <Can permission={['invoices.create', 'payments.create']}>
            <Button className="w-full" disabled={!cart.length || busy} onClick={charge}>
              {busy ? 'Procesando…' : `Cobrar ${total.toFixed(2)}`}
            </Button>
          </Can>
        </div>
      </Card>
    </div>
  );
}
