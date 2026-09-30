/**
 * Cuenta del punto de venta: lógica pura, sin React.
 *
 * Los importes van en céntimos enteros y se redondean igual que la factura del servidor
 * (`invoice.entity.ts`): bruto = precio × cantidad, neto = bruto − descuento, IVA sobre el
 * neto, cada paso redondeado al céntimo. Si la pantalla sumara de otra forma, el cobro
 * exacto que exige la API fallaría por un céntimo.
 */

export type ItemKind = 'SERVICE' | 'PRODUCT';

export interface SaleItem {
  kind: ItemKind;
  id: string;
  name: string;
  /** Precio unitario sin IVA, como lo devuelve la API. */
  price: string;
  taxRate: number | string;
  color?: string | null;
  durationMinutes?: number;
  stockOnHand?: string | null;
  trackStock?: boolean;
  sku?: string | null;
}

export interface CartLine {
  key: string;
  item: SaleItem;
  quantity: number;
  stylistId: string | null;
  discountCents: number;
}

export interface LineAmounts {
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
}

export const toCents = (amount: string | number): number => Math.round(Number(amount) * 100);
export const fromCents = (cents: number): number => cents / 100;

/**
 * Un servicio se agrupa por profesional —dos lavados de dos estilistas son dos líneas, con
 * dos comisiones—; un producto, solo por artículo, como exige la API por el kardex.
 */
export const lineKey = (item: Pick<SaleItem, 'kind' | 'id'>, stylistId: string | null) =>
  item.kind === 'SERVICE' ? `SERVICE:${item.id}:${stylistId ?? ''}` : `PRODUCT:${item.id}`;

export const unitTotalCents = (item: SaleItem): number => {
  const net = toCents(item.price);
  return net + Math.round((net * Number(item.taxRate)) / 100);
};

export function lineAmounts(line: CartLine): LineAmounts {
  const grossCents = Math.round(toCents(line.item.price) * line.quantity);
  const discountCents = Math.min(Math.max(line.discountCents, 0), grossCents);
  const netCents = grossCents - discountCents;
  const taxCents = Math.round((netCents * Number(line.item.taxRate)) / 100);
  return { grossCents, discountCents, netCents, taxCents, totalCents: netCents + taxCents };
}

export function cartTotals(lines: readonly CartLine[]) {
  return lines.reduce(
    (sum, line) => {
      const amounts = lineAmounts(line);
      return {
        subtotalCents: sum.subtotalCents + amounts.grossCents,
        discountCents: sum.discountCents + amounts.discountCents,
        taxCents: sum.taxCents + amounts.taxCents,
        totalCents: sum.totalCents + amounts.totalCents,
      };
    },
    { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 },
  );
}

/** Existencias que se pueden vender. Lo que no lleva control de stock no tiene tope. */
export const availableStock = (item: SaleItem): number =>
  item.kind === 'PRODUCT' && item.trackStock !== false && item.stockOnHand != null
    ? Number(item.stockOnHand)
    : Infinity;

export const isSoldOut = (item: SaleItem) => availableStock(item) <= 0;

export type CartResult = { lines: CartLine[]; error?: string };

/** Agrega una unidad, sumándola a la línea equivalente si ya existe. */
export function addItem(
  lines: readonly CartLine[],
  item: SaleItem,
  stylistId: string | null,
): CartResult {
  const key = lineKey(item, stylistId);
  const existing = lines.find((line) => line.key === key);
  const quantity = (existing?.quantity ?? 0) + 1;

  if (quantity > availableStock(item)) {
    return { lines: [...lines], error: `No hay más existencias de ${item.name}.` };
  }
  if (existing) {
    return { lines: lines.map((line) => (line.key === key ? { ...line, quantity } : line)) };
  }
  return { lines: [...lines, { key, item, quantity: 1, stylistId, discountCents: 0 }] };
}

/**
 * Cambia la cantidad de una línea. Los servicios van por unidades; los productos admiten
 * hasta tres decimales (un tinte a granel, por ejemplo), como la API.
 */
export function setQuantity(
  lines: readonly CartLine[],
  key: string,
  requested: number,
): CartResult {
  const line = lines.find((candidate) => candidate.key === key);
  if (!line || !Number.isFinite(requested)) return { lines: [...lines] };

  const quantity =
    line.item.kind === 'SERVICE'
      ? Math.max(1, Math.round(requested))
      : Math.max(0.001, Math.round(requested * 1000) / 1000);
  const available = availableStock(line.item);
  if (quantity > available) {
    return {
      lines: lines.map((candidate) =>
        candidate.key === key ? { ...candidate, quantity: available } : candidate,
      ),
      error: `Solo quedan ${available} de ${line.item.name}.`,
    };
  }
  return {
    lines: lines.map((candidate) =>
      candidate.key === key ? { ...candidate, quantity } : candidate,
    ),
  };
}

/**
 * Reasigna la profesional de una línea. Si ya había una línea del mismo servicio con esa
 * profesional, se funden: la API no admite dos líneas idénticas.
 */
export function setStylist(
  lines: readonly CartLine[],
  key: string,
  stylistId: string | null,
): CartLine[] {
  const line = lines.find((candidate) => candidate.key === key);
  if (!line) return [...lines];

  const nextKey = lineKey(line.item, stylistId);
  const twin = lines.find((candidate) => candidate.key === nextKey && candidate.key !== key);
  if (!twin) {
    return lines.map((candidate) =>
      candidate.key === key ? { ...candidate, key: nextKey, stylistId } : candidate,
    );
  }
  return lines
    .filter((candidate) => candidate.key !== key)
    .map((candidate) =>
      candidate.key === nextKey
        ? {
            ...candidate,
            quantity: candidate.quantity + line.quantity,
            discountCents: candidate.discountCents + line.discountCents,
          }
        : candidate,
    );
}

/** Fija el descuento de una línea, acotado entre cero y el bruto de la línea. */
export function setDiscount(
  lines: readonly CartLine[],
  key: string,
  discountCents: number,
): CartLine[] {
  return lines.map((line) => {
    if (line.key !== key) return line;
    const gross = lineAmounts({ ...line, discountCents: 0 }).grossCents;
    return { ...line, discountCents: Math.min(Math.max(Math.round(discountCents), 0), gross) };
  });
}

export const discountFromPercent = (grossCents: number, percent: number): number =>
  Math.round((grossCents * Math.min(Math.max(percent, 0), 100)) / 100);

export const removeLine = (lines: readonly CartLine[], key: string): CartLine[] =>
  lines.filter((line) => line.key !== key);

/** Líneas tal como las espera `POST /sales`. */
export const toSaleLines = (lines: readonly CartLine[]) =>
  lines.map((line) => ({
    kind: line.item.kind,
    itemId: line.item.id,
    quantity: line.quantity,
    ...(line.stylistId ? { stylistId: line.stylistId } : {}),
    ...(line.discountCents > 0 ? { discountAmount: fromCents(line.discountCents) } : {}),
  }));
