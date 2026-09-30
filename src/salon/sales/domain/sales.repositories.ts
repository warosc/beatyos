import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Money } from '../../../shared/domain/value-objects/money.vo';
import type { Invoice, InvoiceStatusValue } from './invoice.entity';
import type { Payment, PaymentMethodValue } from './payment.entity';

// ---------------------------------------------------------------------------
// Facturas
// ---------------------------------------------------------------------------

export interface InvoiceFilter {
  readonly search?: string;
  readonly clientId?: string;
  readonly stylistId?: string;
  readonly status?: InvoiceStatusValue;
  readonly from?: Date;
  readonly to?: Date;
  /** Solo las que tienen saldo pendiente. Es la consulta de deudores. */
  readonly onlyUnpaid?: boolean;
  /** Solo las cobradas, en todo o en parte, con este método. */
  readonly method?: PaymentMethodValue;
}

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/** Lo facturado en un periodo: el lado del documento en el cuadre. */
export interface InvoiceTotals {
  /** Ventas vigentes; las anuladas van aparte. */
  readonly count: number;
  readonly total: Money;
  readonly discountTotal: Money;
  readonly voidCount: number;
}

export type InvoiceSortField = 'issuedAt' | 'number' | 'total' | 'createdAt';

export interface InvoiceRepository extends SearchableRepository<
  Invoice,
  InvoiceFilter,
  InvoiceSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Invoice>;

  /** Factura emitida para una cita. `null` si aún no se ha cobrado. */
  findByAppointmentId(appointmentId: string): Promise<Invoice | null>;

  /**
   * Guarda la factura **con sus líneas y sus cobros** en una sola operación.
   *
   * Las líneas y los cobros no tienen vida propia fuera de la factura: no se consultan
   * sueltos ni se modifican por separado, así que el agregado es el documento entero. Un
   * repositorio de líneas permitiría escribir una línea sin recalcular el total, y ese es
   * el camino más corto a una factura que no suma.
   */
  create(invoice: Invoice, payments: readonly Payment[]): Promise<Invoice>;

  update(invoice: Invoice): Promise<Invoice>;

  /** Totales de las facturas emitidas en el periodo. */
  summarize(range: DateRange): Promise<InvoiceTotals>;

  search(
    filter: InvoiceFilter,
    page: PageRequest<InvoiceSortField>,
    options?: QueryOptions,
  ): Promise<Page<Invoice>>;
}

export const INVOICE_REPOSITORY = Symbol('InvoiceRepository');

// ---------------------------------------------------------------------------
// Cobros
// ---------------------------------------------------------------------------

/**
 * Lo cobrado y lo devuelto con un método en un periodo: el lado del dinero en el cuadre.
 *
 * Se cuenta por la fecha de cada hecho —el cobro por `receivedAt`, la devolución por
 * `refundedAt`— y no por la de la factura. Una venta de ayer anulada hoy devuelve dinero
 * hoy, y es hoy cuando falta en el cajón o en el datáfono.
 */
export interface PaymentMethodTotals {
  readonly method: PaymentMethodValue;
  readonly received: Money;
  readonly refunded: Money;
}

export interface PaymentRepository {
  findByInvoiceId(invoiceId: string): Promise<Payment[]>;

  /** Cobros de varias facturas en una consulta: la lista de ventas no hace una por fila. */
  findByInvoiceIds(invoiceIds: readonly string[]): Promise<Payment[]>;

  summarizeByMethod(range: DateRange): Promise<PaymentMethodTotals[]>;

  /** Guarda una devolución: estado, importe devuelto, fecha y motivo. Nada más cambia. */
  update(payment: Payment): Promise<Payment>;

  /**
   * Total cobrado en efectivo en una sesión de caja, sin restar devoluciones: esas salen
   * del cajón como movimiento de la caja en la que se entregan (ADR-0020).
   *
   * Lo resuelve la base con un agregado en lugar de traerse los cobros y sumarlos en
   * memoria: es la cifra que se pinta en cada carga de la pantalla de caja y el número de
   * cobros de un sábado no es pequeño.
   */
  cashTotalForSession(sessionId: string, currency: string): Promise<Money>;
}

export const PAYMENT_REPOSITORY = Symbol('PaymentRepository');

// ---------------------------------------------------------------------------
// Nombres para mostrar
// ---------------------------------------------------------------------------

export interface SalesNames {
  readonly clients: ReadonlyMap<string, string>;
  readonly users: ReadonlyMap<string, string>;
  readonly stylists: ReadonlyMap<string, string>;
}

/**
 * Nombres de clientas, usuarios y profesionales para pintar ventas.
 *
 * Es un puerto de solo lectura y no una relación del agregado: la factura guarda
 * identificadores, y el nombre es presentación. Se resuelve aquí porque recepción, que es
 * quien cuadra, no puede consultar usuarios (`users.read`) para saber quién cobró.
 */
export interface SalesDirectory {
  namesFor(ids: {
    readonly clientIds: readonly string[];
    readonly userIds: readonly string[];
    readonly stylistIds: readonly string[];
  }): Promise<SalesNames>;
}

export const SALES_DIRECTORY = Symbol('SalesDirectory');

// ---------------------------------------------------------------------------
// Numeración de documentos
// ---------------------------------------------------------------------------

export type DocumentTypeValue = 'INVOICE' | 'PURCHASE_ORDER' | 'CREDIT_NOTE';

/**
 * Numerador de documentos fiscales.
 *
 * Es un puerto aparte y no un método del repositorio de facturas porque la garantía que
 * ofrece es de otra naturaleza: la serie tiene que ser **consecutiva y sin huecos** dentro
 * del ejercicio, y eso obliga a serializar. Dos facturas con el mismo número, o un salto en
 * la serie, son un problema con Hacienda y no un detalle de implementación.
 *
 * La implementación debe reservar el número con un `UPDATE ... RETURNING` sobre la fila del
 * contador, dentro de la misma transacción que crea la factura: así el número solo se
 * consume si el documento llega a existir.
 */
export interface DocumentNumberGenerator {
  next(documentType: DocumentTypeValue, year: number): Promise<string>;
}

export const DOCUMENT_NUMBER_GENERATOR = Symbol('DocumentNumberGenerator');
