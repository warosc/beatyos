import type { SaleItem } from './cart';

/**
 * Lo más vendido **en este equipo**, guardado en el navegador.
 *
 * No hay ranking de ventas que recepción pueda consultar (los informes exigen
 * `reports.read`), y lo que más se cobra en un mostrador es lo que ese mostrador cobra: no
 * hace falta más. Es una comodidad: si el almacenamiento no está disponible, la pantalla
 * funciona igual sin atajos.
 */

const KEY = 'beautyos.pos.frequent';
const MAX_ENTRIES = 60;
const FORGET_AFTER_MS = 60 * 86_400_000;

interface Entry {
  item: SaleItem;
  count: number;
  lastUsed: number;
}

const itemKey = (item: Pick<SaleItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

function read(): Record<string, Entry> {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

function write(entries: Record<string, Entry>) {
  try {
    const kept = Object.entries(entries)
      .sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
      .slice(0, MAX_ENTRIES);
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Almacenamiento lleno, bloqueado o en modo privado: se pierde el atajo, nada más.
  }
}

export function frequentItems(limit = 8): SaleItem[] {
  const now = Date.now();
  return Object.values(read())
    .filter((entry) => now - entry.lastUsed < FORGET_AFTER_MS)
    .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Cuenta lo cobrado en una venta. Se llama al completarla, no al agregar a la cuenta. */
export function recordSale(items: readonly SaleItem[]) {
  const entries = read();
  const now = Date.now();
  for (const item of items) {
    const key = itemKey(item);
    entries[key] = { item, count: (entries[key]?.count ?? 0) + 1, lastUsed: now };
  }
  write(entries);
}

/**
 * Refresca la copia guardada con lo que acaba de devolver el catálogo. Así un atajo no
 * arrastra un precio viejo, que haría fallar el cobro exacto.
 */
export function refreshFrequent(items: readonly SaleItem[]) {
  const entries = read();
  let changed = false;
  for (const item of items) {
    const entry = entries[itemKey(item)];
    if (entry && JSON.stringify(entry.item) !== JSON.stringify(item)) {
      entry.item = item;
      changed = true;
    }
  }
  if (changed) write(entries);
}
