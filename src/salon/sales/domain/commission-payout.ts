import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { StylistSalesTotals } from './sales.repositories';

/** Lo cobrado de un tipo —servicios o productos— a nombre de una profesional. */
export interface CommissionBucket {
  /** Servicios realizados o unidades de producto cobradas. */
  readonly count: number;
  /** Lo que pagaron las clientas por esas líneas, después de descuentos. */
  readonly sold: Money;
  readonly commission: Money;
}

/** Lo que hay que pagarle a una profesional por un periodo, desglosado (ADR-0027). */
export interface StylistCommissionPayout {
  readonly stylistId: string;
  readonly stylistName: string;
  readonly services: CommissionBucket;
  readonly products: CommissionBucket;
  /** Servicios más productos: lo que se le entrega al cerrar la caja. */
  readonly total: Money;
}

/**
 * Comisiones a pagar por profesional, a partir de lo vendido en el periodo.
 *
 * Servicios y productos quedan en cubos separados porque son dos comisiones distintas, con
 * su propio porcentaje: la dueña tiene que poder ver cuánto sale de cada una. El total solo
 * existe para saber cuánto entregarle. Las comisiones ya vienen calculadas y congeladas en
 * cada línea al facturar; aquí solo se agrupan.
 *
 * Una profesional sin nombre resuelto —no debería pasar, el directorio incluye a las dadas
 * de baja— se muestra como «Profesional» para que su dinero no desaparezca del cierre.
 */
export const commissionPayouts = (
  rows: readonly StylistSalesTotals[],
  names: ReadonlyMap<string, string>,
  currency: string,
): StylistCommissionPayout[] => {
  const empty = (): CommissionBucket => ({
    count: 0,
    sold: Money.zero(currency),
    commission: Money.zero(currency),
  });
  const byStylist = new Map<string, { services: CommissionBucket; products: CommissionBucket }>();

  for (const row of rows) {
    const current = byStylist.get(row.stylistId) ?? { services: empty(), products: empty() };
    const key = row.kind === 'SERVICE' ? 'services' : 'products';
    const bucket = current[key];
    byStylist.set(row.stylistId, {
      ...current,
      [key]: {
        count: Math.round((bucket.count + row.quantity) * 1000) / 1000,
        sold: bucket.sold.add(row.sold),
        commission: bucket.commission.add(row.commission),
      },
    });
  }

  return [...byStylist.entries()]
    .map(([stylistId, buckets]) => ({
      stylistId,
      stylistName: names.get(stylistId) ?? 'Profesional',
      ...buckets,
      total: buckets.services.commission.add(buckets.products.commission),
    }))
    .sort((a, b) => a.stylistName.localeCompare(b.stylistName, 'es'));
};
