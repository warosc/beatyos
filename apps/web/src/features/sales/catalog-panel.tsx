'use client';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { loadPage } from '@/lib/pagination';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn, money } from '@/lib/utils';
import { isSoldOut, unitTotalCents, type ItemKind, type SaleItem } from './cart';
import { frequentItems, refreshFrequent } from './frequent-items';

type ServiceRow = {
  id: string;
  name: string;
  price: string;
  taxRate: number | string;
  color: string | null;
  durationMinutes: number;
};
type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  price: string;
  taxRate: number | string;
  stockOnHand: string | null;
  trackStock: boolean;
};
type Category = { id: string; name: string };

const PAGE = 40;
const LIST_ID = 'pos-catalog-results';
export const FREQUENT_KEY = ['pos-frequent'] as const;

const asService = (row: ServiceRow): SaleItem => ({
  kind: 'SERVICE',
  id: row.id,
  name: row.name,
  price: row.price,
  taxRate: row.taxRate,
  color: row.color,
  durationMinutes: row.durationMinutes,
});
const asProduct = (row: ProductRow): SaleItem => ({
  kind: 'PRODUCT',
  id: row.id,
  name: row.name,
  sku: row.sku,
  price: row.price,
  taxRate: row.taxRate,
  stockOnHand: row.stockOnHand,
  trackStock: row.trackStock,
});

function catalogUrl(kind: ItemKind, params: { search?: string; categoryId?: string | null }) {
  const query = new URLSearchParams({ limit: String(PAGE), isActive: 'true' });
  if (params.search) query.set('search', params.search);
  if (params.categoryId) query.set('categoryId', params.categoryId);
  if (kind === 'SERVICE') {
    query.set('sort', 'sortOrder:asc');
    return `/api/agenda?resource=services&${query}`;
  }
  // Solo lo que se vende en mostrador: los productos de cabina no se cobran a la clienta.
  query.set('isRetail', 'true');
  return `/api/inventory?resource=products&${query}`;
}

async function fetchItems(kind: ItemKind, url: string, signal?: AbortSignal) {
  const page = await loadPage<ServiceRow & ProductRow>(url, signal);
  return {
    items: page.data.map((row) => (kind === 'SERVICE' ? asService(row) : asProduct(row))),
    meta: page.meta,
  };
}

/**
 * Catálogo del punto de venta.
 *
 * Con un catálogo grande, descargarlo entero al abrir la pantalla no escala: aquí se pide
 * por páginas y se busca en el servidor, que ya busca en nombre, código, SKU y código de
 * barras. Escribir y pulsar Enter agrega el primer resultado.
 */
export function CatalogPanel({
  onAdd,
  searchRef,
  className,
}: {
  onAdd: (item: SaleItem) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const { can } = useAccess();
  const kinds = (['SERVICE', 'PRODUCT'] as const).filter((kind) =>
    can(kind === 'SERVICE' ? 'services.read' : 'products.read'),
  );
  const qc = useQueryClient();
  const [tab, setTab] = useState<ItemKind>(kinds[0] ?? 'SERVICE');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const search = useDebouncedValue(text.trim(), 250);
  const searching = search.length > 0;
  // El resultado marcado vuelve al primero al cambiar lo que se lista: se guarda junto a la
  // lista a la que pertenece en lugar de reiniciarlo con un efecto.
  const listKey = `${search}|${tab}|${categoryId}`;
  const [marked, setMarked] = useState({ listKey, index: 0 });
  const active = marked.listKey === listKey ? marked.index : 0;
  const setActive = (index: number) => setMarked({ listKey, index });

  // Solo en el navegador: el almacenamiento local no existe al renderizar en el servidor.
  const frequent = useQuery({
    queryKey: FREQUENT_KEY,
    staleTime: Infinity,
    queryFn: () => frequentItems(),
  });

  const categories = useQuery({
    queryKey: ['pos-categories', tab],
    enabled: can('categories.read'),
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      loadPage<Category>(
        `/api/agenda?resource=categories&kind=${tab}&isActive=true&limit=100`,
        signal,
      ).then((page) => page.data),
  });

  const browse = useInfiniteQuery({
    queryKey: ['pos-catalog', 'browse', tab, categoryId],
    enabled: !searching && kinds.includes(tab),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchItems(tab, `${catalogUrl(tab, { categoryId })}&page=${pageParam}`, signal),
    getNextPageParam: (last) => (last.meta?.hasNext ? last.meta.page + 1 : undefined),
  });

  // Al buscar se busca en todo, sin pestaña ni categoría: quien escribe «champú» estando en
  // Servicios quiere el champú, no una lista vacía.
  const searchQuery = (term: string) => ({
    queryKey: ['pos-catalog', 'search', term],
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const results = await Promise.all(
        kinds.map((kind) => fetchItems(kind, catalogUrl(kind, { search: term }), signal)),
      );
      return results.flatMap((result) => result.items);
    },
  });
  const found = useQuery({ ...searchQuery(search), enabled: searching });

  const items = useMemo(
    () => (searching ? (found.data ?? []) : (browse.data?.pages.flatMap((p) => p.items) ?? [])),
    [searching, found.data, browse.data],
  );

  useEffect(() => {
    if (items.length) refreshFrequent(items);
  }, [items]);

  const pending = searching ? found.isPending : browse.isPending;
  const error = searching ? found.error : browse.error;

  /**
   * `typed` es lo que se buscó para llegar al artículo. El buscador solo se limpia si sigue
   * mostrando eso: quien teclea rápido ya puede estar escribiendo el siguiente, y borrárselo
   * le haría perder esa línea sin darse cuenta.
   */
  function add(item: SaleItem, typed?: string) {
    if (isSoldOut(item)) return;
    onAdd(item);
    setText((current) => (typed === undefined || current.trim() === typed ? '' : current));
    searchRef.current?.focus();
  }

  /**
   * Quien teclea rápido pulsa Enter antes de que termine la pausa de la búsqueda: se busca
   * en ese momento lo escrito y se agrega el primer resultado, nunca uno de la búsqueda
   * anterior.
   */
  async function addFirstMatch(term: string) {
    const results = await qc.fetchQuery(searchQuery(term)).catch(() => []);
    const first = results.find((item) => !isSoldOut(item));
    if (first) add(first, term);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const term = text.trim();
      if (term !== search || (searching && found.isFetching)) {
        if (term) void addFirstMatch(term);
        return;
      }
      const item = items[active];
      if (item) add(item);
    } else if (event.key === 'Escape' && text) {
      event.preventDefault();
      setText('');
    }
  }

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="space-y-3 border-b p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold">Nueva venta</h1>
          <p className="hidden text-xs text-muted-foreground sm:block">
            <kbd className="rounded border px-1.5">/</kbd> buscar ·{' '}
            <kbd className="rounded border px-1.5">↑↓</kbd> elegir ·{' '}
            <kbd className="rounded border px-1.5">Enter</kbd> agregar
          </p>
        </div>
        <label className="flex h-12 items-center gap-2 rounded-xl border bg-background px-3 focus-within:ring-2 focus-within:ring-primary">
          <Search size={18} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={LIST_ID}
            aria-activedescendant={items[active] ? `pos-item-${active}` : undefined}
            aria-label="Buscar servicio o producto"
            placeholder="Buscar por nombre, SKU o código de barras…"
            className="w-full bg-transparent outline-none"
          />
          {text && (
            <button
              type="button"
              aria-label="Limpiar búsqueda"
              onClick={() => {
                setText('');
                searchRef.current?.focus();
              }}
              className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
            >
              <X size={16} />
            </button>
          )}
        </label>

        {!searching && (
          <>
            {kinds.length > 1 && (
              <div
                role="tablist"
                aria-label="Tipo de artículo"
                className="flex gap-1 rounded-xl bg-muted p-1"
              >
                {kinds.map((kind) => (
                  <button
                    key={kind}
                    role="tab"
                    aria-selected={tab === kind}
                    onClick={() => {
                      setTab(kind);
                      setCategoryId(null);
                    }}
                    className={cn(
                      'h-9 flex-1 rounded-lg text-sm font-semibold text-muted-foreground transition',
                      tab === kind && 'bg-card text-foreground shadow-sm',
                    )}
                  >
                    {kind === 'SERVICE' ? 'Servicios' : 'Productos'}
                  </button>
                ))}
              </div>
            )}
            {!!categories.data?.length && (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Categorías">
                <Chip selected={!categoryId} onClick={() => setCategoryId(null)}>
                  Todas
                </Chip>
                {categories.data.map((category) => (
                  <Chip
                    key={category.id}
                    selected={categoryId === category.id}
                    onClick={() => setCategoryId(category.id)}
                  >
                    {category.name}
                  </Chip>
                ))}
              </div>
            )}
            {!!frequent.data?.length && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">Frecuentes</span>
                {frequent.data.map((item) => (
                  <button
                    key={`${item.kind}-${item.id}`}
                    onClick={() => add(item)}
                    className="inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-full border bg-card px-3 text-xs font-medium hover:border-primary"
                  >
                    <Plus size={12} className="shrink-0 text-primary" />
                    <span className="truncate">{item.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto max-lg:max-h-[60vh]">
        {error ? (
          <p role="alert" className="p-6 text-sm text-danger">
            No se pudo cargar el catálogo.{' '}
            <button
              className="font-semibold underline"
              onClick={() => (searching ? found.refetch() : browse.refetch())}
            >
              Reintentar
            </button>
          </p>
        ) : pending ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {searching ? 'Buscando…' : 'Cargando catálogo…'}
          </p>
        ) : items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            {searching ? `Nada coincide con «${search}».` : 'No hay artículos en esta categoría.'}
          </p>
        ) : (
          <ul id={LIST_ID} role="listbox" aria-label="Resultados" className="divide-y">
            {items.map((item, index) => (
              <CatalogRow
                key={`${item.kind}-${item.id}`}
                id={`pos-item-${index}`}
                item={item}
                active={index === active}
                showKind={searching}
                onAdd={() => add(item)}
                onHover={() => index !== active && setActive(index)}
              />
            ))}
          </ul>
        )}
        {!searching && browse.hasNextPage && (
          <div className="p-4 text-center">
            <Button
              variant="outline"
              disabled={browse.isFetchingNextPage}
              onClick={() => browse.fetchNextPage()}
            >
              {browse.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function CatalogRow({
  id,
  item,
  active,
  showKind,
  onAdd,
  onHover,
}: {
  id: string;
  item: SaleItem;
  active: boolean;
  showKind: boolean;
  onAdd: () => void;
  onHover: () => void;
}) {
  const soldOut = isSoldOut(item);
  const stock =
    item.kind === 'PRODUCT' && item.trackStock !== false ? Number(item.stockOnHand ?? 0) : null;
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={soldOut}
      onClick={onAdd}
      onMouseMove={onHover}
      className={cn(
        'flex cursor-pointer items-center gap-3 px-4 py-2.5 transition',
        active && 'bg-muted',
        soldOut && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: item.color ?? 'var(--color-border)' }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{item.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {showKind && (item.kind === 'SERVICE' ? 'Servicio · ' : 'Producto · ')}
          {item.kind === 'SERVICE'
            ? `${item.durationMinutes ?? 0} min`
            : [item.sku, stock == null ? 'Sin control de stock' : null].filter(Boolean).join(' · ')}
        </p>
      </div>
      {stock != null && (
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold',
            stock <= 0
              ? 'bg-danger/10 text-danger'
              : stock <= 3
                ? 'bg-warning/15 text-warning'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {stock <= 0 ? 'Agotado' : `Stock ${stock}`}
        </span>
      )}
      <span className="w-24 text-right font-semibold tabular-nums">
        {money(unitTotalCents(item) / 100)}
      </span>
      <span
        aria-hidden
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg text-primary',
          active ? 'bg-primary text-primary-foreground' : 'bg-secondary',
        )}
      >
        <Plus size={16} />
      </span>
    </li>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'h-8 shrink-0 rounded-full border px-3 text-xs font-semibold transition',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'bg-card hover:border-primary',
      )}
    >
      {children}
    </button>
  );
}
