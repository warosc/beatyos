import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Money } from '../../../shared/domain/value-objects/money.vo';
import type { Invoice, InvoiceStatusValue } from './invoice.entity';
import type { Payment } from './payment.entity';

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

export interface PaymentRepository {
  findByInvoiceId(invoiceId: string): Promise<Payment[]>;

  /**
   * Total cobrado en efectivo en una sesión de caja.
   *
   * Lo resuelve la base con un agregado en lugar de traerse los cobros y sumarlos en
   * memoria: es la cifra que se pinta en cada carga de la pantalla de caja y el número de
   * cobros de un sábado no es pequeño.
   */
  cashTotalForSession(sessionId: string, currency: string): Promise<Money>;
}

export const PAYMENT_REPOSITORY = Symbol('PaymentRepository');

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
