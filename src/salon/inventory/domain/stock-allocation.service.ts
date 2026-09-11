import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { Batch } from './batch.entity';

/**
 * Reparto FEFO de una salida entre lotes (ADR-0012).
 *
 * **First Expired, First Out**: se consume primero el lote que caduca antes, no el que
 * llegó antes.
 *
 * La diferencia con FIFO parece un matiz y no lo es. Cuando un proveedor liquida
 * existencias, un pedido reciente puede traer producto con caducidad más corta que el que
 * ya había. FIFO lo dejaría al fondo y ese lote caducaría en la estantería; FEFO lo saca
 * primero. **FIFO minimiza la antigüedad contable, FEFO minimiza el desperdicio real.**
 *
 * Es un servicio de dominio sin estado ni dependencias: entran lotes y una cantidad, sale
 * el reparto. Eso lo hace trivial de probar, que es justo lo que se quiere para la pieza
 * de la que depende el coste de cada servicio.
 */

/** Tramo de una salida atribuido a un lote concreto. */
export interface Allocation {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly quantity: number;
  readonly unitCost: Money;
  /** `quantity × unitCost`. Es el coste **real**, no una media. */
  readonly cost: Money;
  readonly expiresAt: Date | null;
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[];
  readonly totalCost: Money;
  /** Coste medio efectivo de esta salida. Solo para mostrar; el real es el de cada tramo. */
  readonly averageUnitCost: Money;
}

const QUANTITY_EPSILON = 0.0005;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export const StockAllocationService = {
  /**
   * Ordena los lotes por criterio FEFO.
   *
   * Primero los que caducan antes; los que no caducan van al final —no urge gastarlos—.
   * A igualdad de caducidad desempata la fecha de recepción, de modo que el orden sea
   * determinista: sin desempate, dos ejecuciones podrían repartir distinto y el coste de
   * un mismo servicio variaría sin motivo.
   */
  sortByFefo(batches: readonly Batch[]): Batch[] {
    return [...batches].sort((a, b) => {
      const expiryA = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const expiryB = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;

      if (expiryA !== expiryB) return expiryA - expiryB;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
  },

  /**
   * Reparte una salida entre los lotes disponibles.
   *
   * **No muta nada.** Devuelve el plan de consumo; aplicarlo es cosa del caso de uso,
   * dentro de una transacción y junto con los movimientos del ledger. Separar el cálculo
   * de la escritura permite comprobar la disponibilidad y avisar antes de tocar la base.
   */
  allocate(params: {
    batches: readonly Batch[];
    quantity: number;
    currency: string;
    now: Date;
    /** Permite consumir de lotes caducados. Exige permiso y queda auditado (ADR-0012). */
    allowExpired?: boolean;
  }): AllocationResult {
    const { batches, quantity, currency, now } = params;

    if (!(quantity > 0)) {
      throw new DomainValidationError('La cantidad debe ser mayor que cero', 'quantity');
    }

    const usable = params.allowExpired
      ? batches.filter((batch) => !batch.isDepleted && !batch.isDeleted)
      : batches.filter((batch) => batch.isAvailable(now));

    const available = round3(usable.reduce((total, batch) => total + batch.remainingQuantity, 0));

    if (available + QUANTITY_EPSILON < quantity) {
      // El mensaje distingue entre «no hay» y «hay pero está caducado»: son dos problemas
      // distintos y el segundo tiene solución —revisar los lotes— mientras el primero
      // exige comprar.
      const expiredQuantity = round3(
        batches
          .filter((batch) => batch.isExpired(now) && !batch.isDepleted && !batch.isDeleted)
          .reduce((total, batch) => total + batch.remainingQuantity, 0),
      );

      throw new BusinessRuleViolationError(
        'INSUFFICIENT_STOCK',
        expiredQuantity > 0 && !params.allowExpired
          ? `Existencias insuficientes: hay ${available} disponibles y ${expiredQuantity} en lotes caducados`
          : `Existencias insuficientes: se piden ${quantity} y hay ${available}`,
        { requested: quantity, available, expiredQuantity },
      );
    }

    const allocations: Allocation[] = [];
    let pending = quantity;

    for (const batch of StockAllocationService.sortByFefo(usable)) {
      if (pending <= QUANTITY_EPSILON) break;

      const taken = round3(Math.min(pending, batch.remainingQuantity));
      if (taken <= 0) continue;

      allocations.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        quantity: taken,
        unitCost: batch.unitCost,
        cost: batch.unitCost.multiply(taken),
        expiresAt: batch.expiresAt,
      });

      pending = round3(pending - taken);
    }

    const totalCost = Money.sum(
      allocations.map((allocation) => allocation.cost),
      currency,
    );

    return {
      allocations,
      totalCost,
      // Media efectiva de ESTA salida. Se calcula para mostrarla; el coste que cuenta es
      // el de cada tramo, que es real.
      averageUnitCost:
        quantity > 0
          ? Money.fromMinorUnits(Math.round(totalCost.minorUnits / quantity), currency)
          : Money.zero(currency),
    };
  },

  /** Existencias disponibles: lo que queda sin caducar. */
  availableQuantity(batches: readonly Batch[], now: Date): number {
    return round3(
      batches
        .filter((batch) => batch.isAvailable(now))
        .reduce((total, batch) => total + batch.remainingQuantity, 0),
    );
  },

  /**
   * Existencias inmovilizadas por caducidad.
   *
   * Es la cifra que interesa al panel: producto que está en la estantería, cuenta como
   * stock a ojos de quien mira, y no se puede usar.
   */
  expiredQuantity(batches: readonly Batch[], now: Date): number {
    return round3(
      batches
        .filter((batch) => batch.isExpired(now) && !batch.isDepleted && !batch.isDeleted)
        .reduce((total, batch) => total + batch.remainingQuantity, 0),
    );
  },

  /** Valor del inventario disponible, sumando el coste real de cada lote. */
  inventoryValue(batches: readonly Batch[], currency: string, now: Date): Money {
    return Money.sum(
      batches.filter((batch) => batch.isAvailable(now)).map((batch) => batch.remainingValue),
      currency,
    );
  },

  /** Lotes que caducan dentro del plazo, ordenados por urgencia. */
  expiringSoon(batches: readonly Batch[], days: number, now: Date): Batch[] {
    return StockAllocationService.sortByFefo(
      batches.filter(
        (batch) => !batch.isDepleted && !batch.isDeleted && batch.expiresWithin(days, now),
      ),
    );
  },

  /**
   * Media móvil ponderada tras una entrada (ADR-0011).
   *
   * Se conserva para los productos **sin** seguimiento por lote, donde no hay un coste
   * real que consultar. La fórmula pondera por cantidad, no por número de compras: recibir
   * 100 unidades a 5 € y 1 a 50 € da una media de 5,45 €, no de 27,50 €.
   */
  weightedAverageCost(params: {
    currentQuantity: number;
    currentUnitCost: Money;
    incomingQuantity: number;
    incomingUnitCost: Money;
  }): Money {
    const { currentQuantity, currentUnitCost, incomingQuantity, incomingUnitCost } = params;

    if (incomingQuantity <= 0) {
      throw new DomainValidationError('La cantidad entrante debe ser mayor que cero', 'quantity');
    }

    const totalQuantity = currentQuantity + incomingQuantity;

    // Con existencias negativas o nulas no hay nada que promediar: manda el coste nuevo.
    // Puede ocurrir tras un ajuste que dejó el stock a cero.
    if (currentQuantity <= 0) return incomingUnitCost;

    const currentValue = currentUnitCost.multiply(currentQuantity);
    const incomingValue = incomingUnitCost.multiply(incomingQuantity);
    const totalValue = currentValue.add(incomingValue);

    return Money.fromMinorUnits(
      Math.round(totalValue.minorUnits / totalQuantity),
      totalValue.currency,
    );
  },
};
