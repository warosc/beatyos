import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InvoiceLine as LineRow, Payment as PaymentRow, Prisma } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '../../../../shared/domain/ports/repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../../shared/domain/value-objects/time-range.vo';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { Invoice, type InvoiceLine } from '../../domain/invoice.entity';
import { Payment } from '../../domain/payment.entity';
import type {
  DocumentNumberGenerator,
  DocumentTypeValue,
  InvoiceFilter,
  InvoiceRepository,
  InvoiceSortField,
  PaymentRepository,
} from '../../domain/sales.repositories';

const INVOICE_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.InvoiceInclude;

type InvoiceWithLines = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

// ===========================================================================
// Facturas
// ===========================================================================

@Injectable()
export class PrismaInvoiceRepository
  extends PrismaRepositoryBase<Invoice, InvoiceWithLines, InvoiceFilter, InvoiceSortField>
  implements InvoiceRepository
{
  private readonly currency: string;

  constructor(
    prisma: PrismaService,
    @Inject(CLOCK) clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    super(prisma, clock);
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  protected readonly delegateName = 'invoice';
  protected readonly entityName = 'Factura';

  protected readonly sortableFields: ReadonlyMap<
    InvoiceSortField,
    OrderByClause | OrderByClause[]
  > = new Map<InvoiceSortField, OrderByClause | OrderByClause[]>([
    ['issuedAt', { issuedAt: true }],
    ['number', { number: true }],
    ['total', { total: true }],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'issuedAt' as const, direction: 'desc' as const }];

  override async findById(id: string, options?: QueryOptions): Promise<Invoice | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.invoice.findFirst({ where: { id }, include: INVOICE_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByAppointmentId(appointmentId: string): Promise<Invoice | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.invoice.findFirst({
        where: { appointmentId },
        include: INVOICE_INCLUDE,
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  override async search(
    filter: InvoiceFilter,
    page: PageRequest<InvoiceSortField>,
    options?: QueryOptions,
  ): Promise<Page<Invoice>> {
    const where = this.buildWhere(filter);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.invoice.count({ where }),
          this.prisma.client.invoice.findMany({
            where,
            orderBy: this.buildOrderBy(page.sort),
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: INVOICE_INCLUDE,
          }),
        ]),
      ),
    );

    return buildPage(
      rows.map((row) => this.toDomain(row)),
      total,
      page,
    );
  }

  /**
   * Crea la factura con sus líneas y sus cobros en una sola escritura anidada.
   *
   * Prisma resuelve el `create` anidado en una transacción implícita, así que no puede
   * quedar una factura sin líneas: sería un documento con un total que ningún desglose
   * justifica, y esa es exactamente la clase de fila que aparece en una inspección.
   */
  async create(invoice: Invoice, payments: readonly Payment[]): Promise<Invoice> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.invoice.create({
        data: {
          id: invoice.id,
          tenantId: invoice.tenantId,
          clientId: invoice.clientId,
          appointmentId: invoice.appointmentId,
          number: invoice.number,
          ...this.toPersistence(invoice),
          createdAt: invoice.audit.createdAt,
          updatedAt: invoice.audit.updatedAt,
          createdBy: invoice.audit.createdBy,
          updatedBy: invoice.audit.updatedBy,
          lines: {
            create: invoice.lines.map((line) => this.lineToPersistence(invoice, line)),
          },
          payments: {
            create: payments.map((payment) => ({
              id: payment.id,
              tenantId: payment.tenantId,
              sessionId: payment.sessionId,
              method: payment.method,
              status: payment.status,
              amount: payment.amount.toDecimalString(),
              currency: payment.amount.currency,
              receivedAt: payment.receivedAt,
              reference: payment.reference,
              externalId: payment.externalId,
              notes: payment.notes,
              createdBy: payment.createdBy,
            })),
          },
        },
        include: INVOICE_INCLUDE,
      }),
    );

    return this.toDomain(row);
  }

  /**
   * Guarda la cabecera. **No toca las líneas**.
   *
   * Una factura emitida no cambia de contenido (ADR-0014): lo que se actualiza es el estado
   * —cobrada, anulada, vencida— y los totales que de él dependen. Permitir reescribir las
   * líneas aquí abriría la puerta a modificar un documento ya entregado al cliente.
   */
  async update(invoice: Invoice): Promise<Invoice> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.invoice.updateMany({
        where: { id: invoice.id },
        data: {
          ...this.toPersistence(invoice),
          updatedAt: invoice.audit.updatedAt,
          updatedBy: invoice.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, invoice.id);
    }

    return this.findByIdOrFail(invoice.id, { includeDeleted: invoice.isDeleted });
  }

  async save(invoice: Invoice): Promise<Invoice> {
    return this.update(invoice);
  }

  protected buildWhere(filter: InvoiceFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['number', 'notes']),
      filter.clientId ? { clientId: filter.clientId } : undefined,
      filter.status ? { status: filter.status } : undefined,
      // Se filtra por la línea y no por la factura: una factura pertenece al salón, pero el
      // trabajo —y la comisión— es de quien lo hizo, y eso vive en la línea.
      filter.stylistId ? { lines: { some: { stylistId: filter.stylistId } } } : undefined,
      this.dateRange(filter.from, filter.to)
        ? { issuedAt: this.dateRange(filter.from, filter.to) }
        : undefined,
      filter.onlyUnpaid ? { balanceDue: { gt: 0 }, status: { not: 'VOID' } } : undefined,
    );
  }

  private toPersistence(invoice: Invoice) {
    return {
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      voidedAt: invoice.voidedAt,
      voidReason: invoice.voidReason,
      subtotal: invoice.subtotal.toDecimalString(),
      discountTotal: invoice.discountTotal.toDecimalString(),
      taxTotal: invoice.taxTotal.toDecimalString(),
      total: invoice.total.toDecimalString(),
      paidTotal: invoice.paidTotal.toDecimalString(),
      balanceDue: invoice.balanceDue.toDecimalString(),
      currency: invoice.currency,
      notes: invoice.notes,
      billingSnapshot: (invoice.billingSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
      deletedAt: invoice.audit.deletedAt,
      deletedBy: invoice.audit.deletedBy,
    };
  }

  private lineToPersistence(invoice: Invoice, line: InvoiceLine) {
    return {
      id: line.id,
      tenantId: invoice.tenantId,
      kind: line.kind,
      serviceId: line.serviceId,
      productId: line.productId,
      stylistId: line.stylistId,
      description: line.description,
      quantity: line.quantity.toFixed(3),
      unitPrice: line.unitPrice.toDecimalString(),
      discountAmount: line.discountAmount.toDecimalString(),
      taxRate: line.taxRate.value.toFixed(2),
      taxAmount: line.taxAmount.toDecimalString(),
      lineSubtotal: line.lineSubtotal.toDecimalString(),
      lineTotal: line.lineTotal.toDecimalString(),
      currency: line.lineTotal.currency,
      commissionRate: line.commissionRate?.value.toFixed(2) ?? null,
      commissionAmount: line.commissionAmount.toDecimalString(),
      sortOrder: line.sortOrder,
    };
  }

  protected toDomain(row: InvoiceWithLines): Invoice {
    const currency = row.currency || this.currency;

    return Invoice.rehydrate(row.id, {
      tenantId: row.tenantId,
      clientId: row.clientId,
      appointmentId: row.appointmentId,
      number: row.number,
      status: row.status,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      paidAt: row.paidAt,
      voidedAt: row.voidedAt,
      voidReason: row.voidReason,
      lines: row.lines.map((line) => this.lineToDomain(line, currency)),
      paidTotal: Money.fromDecimal(row.paidTotal.toFixed(2), currency),
      currency,
      notes: row.notes,
      billingSnapshot: (row.billingSnapshot as Record<string, unknown> | null) ?? null,
      audit: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        deletedBy: row.deletedBy,
      },
    });
  }

  private lineToDomain(row: LineRow, invoiceCurrency: string): InvoiceLine {
    const currency = row.currency || invoiceCurrency;

    return {
      id: row.id,
      kind: row.kind,
      serviceId: row.serviceId,
      productId: row.productId,
      stylistId: row.stylistId,
      description: row.description,
      quantity: Number(row.quantity),
      unitPrice: Money.fromDecimal(row.unitPrice.toFixed(2), currency),
      discountAmount: Money.fromDecimal(row.discountAmount.toFixed(2), currency),
      taxRate: Percentage.create(Number(row.taxRate)),
      taxAmount: Money.fromDecimal(row.taxAmount.toFixed(2), currency),
      lineSubtotal: Money.fromDecimal(row.lineSubtotal.toFixed(2), currency),
      lineTotal: Money.fromDecimal(row.lineTotal.toFixed(2), currency),
      commissionRate:
        row.commissionRate === null ? null : Percentage.create(Number(row.commissionRate)),
      commissionAmount: Money.fromDecimal(row.commissionAmount.toFixed(2), currency),
      sortOrder: row.sortOrder,
    };
  }
}

// ===========================================================================
// Cobros
// ===========================================================================

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  private readonly entityName = 'Cobro';

  async findByInvoiceId(invoiceId: string): Promise<Payment[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.payment.findMany({
        where: { invoiceId },
        orderBy: { receivedAt: 'asc' },
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Efectivo neto imputado a una sesión de caja.
   *
   * Resta lo devuelto: un cobro de 100 con 30 devueltos deja 70 en el cajón, y contar los
   * 100 haría que el arqueo señalara un descuadre que en realidad no existe.
   *
   * Se resuelve con dos agregados en la base y no trayéndose los cobros para sumarlos aquí:
   * es la cifra que se pinta en cada carga de la pantalla de caja, y un sábado no son pocos.
   */
  async cashTotalForSession(sessionId: string, currency: string): Promise<Money> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.payment.aggregate({
        where: {
          sessionId,
          method: 'CASH',
          status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
        },
        _sum: { amount: true, refundedAmount: true },
      }),
    );

    const received = Money.fromDecimal(result._sum.amount?.toFixed(2) ?? '0.00', currency);
    const refunded = Money.fromDecimal(result._sum.refundedAmount?.toFixed(2) ?? '0.00', currency);

    return received.subtract(refunded);
  }

  private toDomain(row: PaymentRow): Payment {
    const currency = row.currency || this.currency;

    return Payment.rehydrate(row.id, {
      tenantId: row.tenantId,
      invoiceId: row.invoiceId,
      sessionId: row.sessionId,
      method: row.method,
      status: row.status,
      amount: Money.fromDecimal(row.amount.toFixed(2), currency),
      receivedAt: row.receivedAt,
      reference: row.reference,
      externalId: row.externalId,
      notes: row.notes,
      refundedAt: row.refundedAt,
      refundedAmount: Money.fromDecimal(row.refundedAmount.toFixed(2), currency),
      refundReason: row.refundReason,
      createdBy: row.createdBy,
    });
  }
}

// ===========================================================================
// Numeración
// ===========================================================================

/**
 * Numerador de documentos fiscales.
 *
 * La serie debe ser **consecutiva y sin huecos** dentro del ejercicio: un salto entre la
 * factura 41 y la 43 es algo que hay que explicar en una inspección, y un número repetido
 * lo es todavía más.
 *
 * El `upsert` con `increment` reserva el número en una sola sentencia, y va dentro de la
 * transacción que crea la factura: si el documento no llega a existir, el contador vuelve
 * atrás con la transacción y no queda hueco. Es la razón de que este puerto **no** se pueda
 * implementar con un contador en memoria ni con un `SELECT max(number) + 1`, que es lo que
 * produce duplicados en cuanto hay dos cajas cobrando a la vez.
 */
@Injectable()
export class PrismaDocumentNumberGenerator implements DocumentNumberGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async next(documentType: DocumentTypeValue, year: number): Promise<string> {
    const tenantId = RequestContextStore.tenantId;

    if (!tenantId) {
      // Sin salón no hay serie: la numeración es por inquilino y por ejercicio, y una
      // factura sin salón no tendría a qué serie pertenecer.
      throw new EntityNotFoundError('Serie de numeración', `${documentType}:${year}`);
    }

    const sequence = await withMappedErrors('Serie de numeración', () =>
      this.prisma.client.documentSequence.upsert({
        where: { tenantId_documentType_year: { tenantId, documentType, year } },
        create: { tenantId, documentType, year, prefix: `F-${year}-`, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      }),
    );

    return `${sequence.prefix}${String(sequence.lastNumber).padStart(6, '0')}`;
  }
}
