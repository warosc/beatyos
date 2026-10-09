import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import {
  BusinessRuleViolationError,
  ConflictError,
  EntityNotFoundError,
} from '../../../shared/domain/errors';
import {
  UNIT_OF_WORK,
  type Page,
  type PageRequest,
  type UnitOfWork,
} from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import {
  CASH_SESSION_REPOSITORY,
  type CashSessionRepository,
} from '../../cash/domain/cash.repositories';
import { CLIENT_REPOSITORY, type ClientRepository } from '../../clients/domain/client.repository';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import {
  ConsumeStockUseCase,
  ReturnSaleStockUseCase,
} from '../../inventory/application/inventory.use-cases';
import {
  PRODUCT_REPOSITORY,
  type ProductRepository,
} from '../../inventory/domain/inventory.repositories';
import type { Product } from '../../inventory/domain/product.entity';
import {
  SERVICE_TICKET_REPOSITORY,
  type ServiceTicketRepository,
} from '../../service-tickets/domain/service-ticket.repository';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import { buildInvoiceLine, Invoice, type InvoiceLine } from '../domain/invoice.entity';
import { Payment, type PaymentMethodValue } from '../domain/payment.entity';
import {
  DOCUMENT_NUMBER_GENERATOR,
  INVOICE_REPOSITORY,
  PAYMENT_REPOSITORY,
  SALES_DIRECTORY,
  type DateRange,
  type DocumentNumberGenerator,
  type InvoiceFilter,
  type InvoiceRepository,
  type InvoiceSortField,
  type InvoiceTotals,
  type PaymentMethodTotals,
  type PaymentRepository,
  type SalesDirectory,
  type SalesNames,
} from '../domain/sales.repositories';

// ===========================================================================
// Registrar una venta
// ===========================================================================

export interface SaleLineInput {
  readonly kind: 'PRODUCT' | 'SERVICE';
  readonly itemId: string;
  readonly quantity: number;
  readonly stylistId?: string | null;
  /** Descuento en importe sobre la línea. El porcentaje lo resuelve quien llama. */
  readonly discountAmount?: string;
}

export interface SalePaymentInput {
  readonly method: PaymentMethodValue;
  readonly amount: string;
  readonly reference?: string | null;
}

export interface RegisterSaleInput {
  readonly tenantId: string;
  readonly lines: readonly SaleLineInput[];
  readonly payments: readonly SalePaymentInput[];
  readonly currency: string;
  readonly clientId?: string | null;
  readonly appointmentId?: string | null;
  readonly notes?: string | null;
  readonly actorId: string;
}

export interface RegisterSaleResult {
  readonly invoice: Invoice;
  readonly payments: readonly Payment[];
}

/**
 * Paso que otro módulo necesita dar **dentro** de la transacción de la venta.
 *
 * Existe para el cobro de comandas (ADR-0019): la comanda tiene que quedar marcada como
 * cobrada en la misma unidad de trabajo que emite la factura. Si fuera un paso posterior,
 * un fallo entre ambos dejaría una factura cobrada con su comanda aún pendiente, y caja
 * la volvería a cobrar.
 */
export type WithinSaleTransaction = (sale: RegisterSaleResult) => Promise<void>;

/**
 * Registra una venta: emite la factura, cobra y descuenta existencias (ADR-0014).
 *
 * Es la operación más entrelazada del sistema —toca facturas, cobros, caja, inventario,
 * cita y ficha de cliente— y por eso va entera en una unidad de trabajo. Que la factura
 * quede emitida y el stock sin descontar, o que se cobre y no se registre la venta, no son
 * estados aceptables.
 *
 * **No descuenta el stock por su cuenta.** Delega en `ConsumeStockUseCase`, que es el motor
 * de inventario reconciliado en el ADR-0013. La versión anterior escribía `stockOnHand`
 * directamente y se saltaba los lotes por completo: un tinte trazado se vendía sin tocar
 * ningún lote, con lo que la trazabilidad quedaba rota justo en la operación que más
 * importa —la que entrega el producto a la clienta— y además reintroducía aquí el mismo
 * fallo de pérdida de escrituras que se acababa de corregir allí (ADR-0002).
 */
@Injectable()
export class RegisterSaleUseCase implements UseCase<RegisterSaleInput, RegisterSaleResult> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(DOCUMENT_NUMBER_GENERATOR) private readonly numbers: DocumentNumberGenerator,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly consumeStock: ConsumeStockUseCase,
  ) {}

  async execute(
    input: RegisterSaleInput,
    withinTransaction?: WithinSaleTransaction,
  ): Promise<RegisterSaleResult> {
    assertNoRepeatedItems(input.lines);

    const result = await this.uow.execute(async () => {
      const now = this.clock.now();

      // La cita se comprueba antes de nada: la columna es única, así que facturar dos veces
      // la misma cita reventaría al insertar con un error de restricción que no explica lo
      // ocurrido. Aquí se dice qué factura la cobró ya.
      if (input.appointmentId) {
        const existing = await this.invoices.findByAppointmentId(input.appointmentId);
        if (existing) {
          throw new ConflictError(
            'APPOINTMENT_ALREADY_INVOICED',
            `Esa cita ya se facturó en el documento ${existing.number}`,
            { invoiceId: existing.id, number: existing.number },
          );
        }
      }

      const { lines, productsById } = await this.buildLines(input);

      const invoice = Invoice.issue({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        number: await this.numbers.next('INVOICE', now.getUTCFullYear()),
        lines,
        currency: input.currency,
        clientId: input.clientId ?? null,
        appointmentId: input.appointmentId ?? null,
        notes: input.notes ?? null,
        now,
        actorId: input.actorId,
      });

      const payments = await this.buildPayments(input, invoice, now);

      // Cada cobro pasa por el agregado, que es quien rechaza el sobrepago y decide si la
      // factura queda pagada o a medias. Calcular el estado aquí, fuera de la entidad,
      // permitiría emitir una factura marcada PAID que no lo está.
      for (const payment of payments) {
        invoice.registerPayment(payment.amount, now, input.actorId);
      }

      const saved = await this.invoices.create(invoice, payments);

      // El stock se descuenta después de existir la factura para poder referenciarla en el
      // kardex: un movimiento de salida sin documento que lo justifique es indistinguible
      // de una merma.
      await this.consumeSoldProducts(input, saved, productsById);

      // La ficha de la clienta se actualiza aquí, no en la agenda: una cita completada sin
      // factura no es una visita a efectos de gasto ni de frecuencia.
      if (input.clientId) {
        const client = await this.clients.findByIdOrFail(input.clientId);
        client.registerVisit(saved.total, now);
        await this.clients.update(client);
      }

      const sale = { invoice: saved, payments };
      await withinTransaction?.(sale);
      return sale;
    });

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Invoice',
      entityId: result.invoice.id,
      after: {
        number: result.invoice.number,
        total: result.invoice.total.toDecimalString(),
        status: result.invoice.status,
        lines: result.invoice.lines.length,
      },
    });

    return result;
  }

  /**
   * Construye las líneas congelando precio, impuesto y comisión.
   *
   * Se congelan al facturar porque una factura es un documento histórico: si mañana sube el
   * precio del tinte, la factura de hoy tiene que seguir diciendo lo que se cobró hoy.
   * Leerlo del catálogo al reimprimir daría un papel distinto cada vez.
   */
  private async buildLines(
    input: RegisterSaleInput,
  ): Promise<{ lines: InvoiceLine[]; productsById: Map<string, Product> }> {
    const productIds = input.lines.filter((l) => l.kind === 'PRODUCT').map((l) => l.itemId);
    const serviceIds = input.lines.filter((l) => l.kind === 'SERVICE').map((l) => l.itemId);
    const stylistIds = [...new Set(input.lines.map((l) => l.stylistId).filter((id) => id != null))];

    const [products, services, stylists] = await Promise.all([
      this.products.findManyByIds(productIds),
      this.services.findManyByIds(serviceIds),
      // Una venta rara vez lleva a más de un par de estilistas: no hace falta un
      // `findManyByIds` en el repositorio solo para esto.
      Promise.all(stylistIds.map((id) => this.stylists.findByIdOrFail(id))),
    ]);

    const productsById = new Map(products.map((product) => [product.id, product]));
    const servicesById = new Map(services.map((service) => [service.id, service]));
    const stylistsById = new Map(stylists.map((stylist) => [stylist.id, stylist]));

    const lines = input.lines.map((line, index) => {
      const isProduct = line.kind === 'PRODUCT';
      const item = isProduct ? productsById.get(line.itemId) : servicesById.get(line.itemId);

      if (!item) {
        // Nombrar el identificador que falta ahorra tener que adivinar cuál de las ocho
        // líneas del ticket es la que ya no existe.
        throw new EntityNotFoundError(isProduct ? 'Producto' : 'Servicio', line.itemId);
      }
      if (!item.isActive) {
        throw new BusinessRuleViolationError(
          'ITEM_NOT_AVAILABLE',
          `${item.name} está dado de baja y no se puede facturar`,
          { itemId: item.id },
        );
      }

      // Sin profesional asignado no hay comisión: devengarla sin saber a quién pagársela
      // produce un pasivo sin destinatario. Con profesional, un servicio usa la cascada
      // completa del dominio (ajuste por habilidad → tarifa del servicio → general de la
      // estilista); un producto no tiene ajuste por habilidad, así que usa directamente su
      // tarifa general.
      const stylist = line.stylistId ? stylistsById.get(line.stylistId) : undefined;
      const commissionRate = stylist
        ? isProduct
          ? stylist.commissionRate
          : stylist.commissionFor(
              line.itemId,
              servicesById.get(line.itemId)?.commissionRate ?? null,
            )
        : null;

      return buildInvoiceLine({
        id: this.ids.generate(),
        kind: line.kind,
        description: item.name,
        quantity: line.quantity,
        unitPrice: item.price,
        taxRate: item.taxRate,
        discountAmount: line.discountAmount
          ? Money.fromDecimal(line.discountAmount, input.currency)
          : undefined,
        commissionRate,
        serviceId: isProduct ? null : line.itemId,
        productId: isProduct ? line.itemId : null,
        stylistId: line.stylistId ?? null,
        sortOrder: index,
      });
    });

    return { lines, productsById };
  }

  /**
   * Construye los cobros y comprueba que cubren el total exactamente.
   *
   * La comparación es exacta, sin tolerancia. La versión anterior admitía un céntimo de
   * diferencia (`Math.abs(total - paid) > 0.01`), que es la confesión de que las cifras no
   * cuadraban por hacer la aritmética en coma flotante. Con `Money` cuadran o no cuadran, y
   * un céntimo perdido cada venta son treinta euros al año que nadie sabe explicar.
   */
  private async buildPayments(
    input: RegisterSaleInput,
    invoice: Invoice,
    now: Date,
  ): Promise<Payment[]> {
    const amounts = input.payments.map((payment) =>
      Money.fromDecimal(payment.amount, input.currency),
    );
    const paid = Money.sum(amounts, input.currency);

    if (!paid.equals(invoice.total)) {
      throw new BusinessRuleViolationError(
        'PAYMENT_TOTAL_MISMATCH',
        `Los cobros suman ${paid.toString()} y el total es ${invoice.total.toString()}`,
        { paid: paid.toDecimalString(), total: invoice.total.toDecimalString() },
      );
    }

    const needsCash = input.payments.some((payment) => payment.method === 'CASH');
    const session = needsCash ? await this.sessions.findOpen() : null;

    if (needsCash && !session) {
      throw new BusinessRuleViolationError(
        'CASH_REQUIRES_OPEN_SESSION',
        'Abra la caja antes de cobrar en efectivo',
      );
    }

    return input.payments.map((payment, index) =>
      Payment.receive({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        invoiceId: invoice.id,
        method: payment.method,
        amount: amounts[index],
        sessionId: payment.method === 'CASH' ? session!.id : null,
        reference: payment.reference ?? null,
        now,
        actorId: input.actorId,
      }),
    );
  }

  /**
   * Descuenta las existencias vendidas por el motor de inventario.
   *
   * Un producto sin control de existencias se salta: hay artículos que se facturan y no se
   * inventarían —un bono, una tarjeta regalo—, y exigirles stock haría imposible venderlos.
   */
  private async consumeSoldProducts(
    input: RegisterSaleInput,
    invoice: Invoice,
    productsById: Map<string, Product>,
  ): Promise<void> {
    for (const line of invoice.productLines) {
      const product = productsById.get(line.productId!);
      if (!product?.trackStock) continue;

      await this.consumeStock.execute({
        tenantId: input.tenantId,
        productId: line.productId!,
        quantity: line.quantity,
        type: 'SALE_OUT',
        sourceType: 'INVOICE',
        sourceId: invoice.id,
        reason: `Venta ${invoice.number}`,
        actorId: input.actorId,
      });
    }
  }
}

// ===========================================================================
// Consultas
// ===========================================================================

/** Nombres de todo lo que aparece en un grupo de ventas, en una sola consulta. */
const namesOf = (directory: SalesDirectory, invoices: readonly Invoice[]): Promise<SalesNames> =>
  directory.namesFor({
    clientIds: invoices.flatMap((invoice) => (invoice.clientId ? [invoice.clientId] : [])),
    userIds: invoices.flatMap((invoice) =>
      invoice.audit.createdBy ? [invoice.audit.createdBy] : [],
    ),
    stylistIds: invoices.flatMap((invoice) =>
      invoice.lines.flatMap((line) => (line.stylistId ? [line.stylistId] : [])),
    ),
  });

export interface SalesPage {
  readonly page: Page<Invoice>;
  readonly payments: readonly Payment[];
  readonly names: SalesNames;
}

/**
 * Ventas realizadas, con sus cobros y los nombres que hacen falta para cuadrar: de quién
 * era la venta, quién la cobró y quién hizo cada servicio.
 */
@Injectable()
export class SearchInvoicesUseCase implements UseCase<
  { filter: InvoiceFilter; page: PageRequest<InvoiceSortField> },
  SalesPage
> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(SALES_DIRECTORY) private readonly directory: SalesDirectory,
  ) {}

  async execute(input: {
    filter: InvoiceFilter;
    page: PageRequest<InvoiceSortField>;
  }): Promise<SalesPage> {
    const page = await this.invoices.search(input.filter, input.page);
    const [payments, names] = await Promise.all([
      this.payments.findByInvoiceIds(page.data.map((invoice) => invoice.id)),
      namesOf(this.directory, page.data),
    ]);
    return { page, payments, names };
  }
}

export interface InvoiceDetail {
  readonly invoice: Invoice;
  readonly payments: readonly Payment[];
  readonly names: SalesNames;
}

@Injectable()
export class GetInvoiceUseCase implements UseCase<{ invoiceId: string }, InvoiceDetail> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(SALES_DIRECTORY) private readonly directory: SalesDirectory,
  ) {}

  async execute(input: { invoiceId: string }): Promise<InvoiceDetail> {
    const invoice = await this.invoices.findByIdOrFail(input.invoiceId);
    const [payments, names] = await Promise.all([
      this.payments.findByInvoiceId(invoice.id),
      namesOf(this.directory, [invoice]),
    ]);
    return { invoice, payments, names };
  }
}

export interface SalesSummary {
  readonly invoices: InvoiceTotals;
  readonly byMethod: readonly PaymentMethodTotals[];
}

/**
 * Cuadre de un periodo —un día, un turno de caja—: lo facturado y, por método, lo cobrado
 * y lo devuelto. Es la cifra que se compara con el cajón, el datáfono y el banco.
 */
@Injectable()
export class SummarizeSalesUseCase implements UseCase<DateRange, SalesSummary> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(range: DateRange): Promise<SalesSummary> {
    if (range.from > range.to) {
      throw new BusinessRuleViolationError(
        'INVALID_DATE_RANGE',
        'La fecha de inicio es posterior a la de fin',
      );
    }
    const [invoices, byMethod] = await Promise.all([
      this.invoices.summarize(range),
      this.payments.summarizeByMethod(range),
    ]);
    return { invoices, byMethod };
  }
}

// ===========================================================================
// Anulación
// ===========================================================================

export interface VoidInvoiceInput {
  readonly invoiceId: string;
  readonly reason: string;
  readonly actorId: string | null;
}

export interface VoidInvoiceResult {
  readonly invoice: Invoice;
  readonly payments: readonly Payment[];
  /** Efectivo que salió de la caja abierta. Cero si la venta no tenía cobros en efectivo. */
  readonly cashRefunded: Money;
}

/**
 * Anula una venta, cobrada o no, deshaciendo todo lo que la venta hizo (ADR-0020).
 *
 * El ADR-0014 exige devolver antes de anular, y aquí se respeta: primero se devuelve cada
 * cobro y después se anula la factura, que sigue negándose a anularse con dinero cobrado.
 * Lo que cambia es que las dos cosas van en una sola operación deliberada de la propietaria,
 * y que la pregunta que motivó aquella regla —de qué caja sale el efectivo— tiene respuesta
 * fija: de la caja abierta, la que tiene delante quien lo entrega. Sin caja abierta no se
 * puede anular una venta con cobros en efectivo.
 *
 * Todo va en una unidad de trabajo: una venta anulada con el stock sin reponer, o con el
 * dinero devuelto y la factura en pie, es un descuadre que nadie sabría explicar.
 */
@Injectable()
export class VoidInvoiceUseCase implements UseCase<VoidInvoiceInput, VoidInvoiceResult> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(CASH_SESSION_REPOSITORY) private readonly sessions: CashSessionRepository,
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(SERVICE_TICKET_REPOSITORY) private readonly tickets: ServiceTicketRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly returnStock: ReturnSaleStockUseCase,
  ) {}

  async execute(input: VoidInvoiceInput): Promise<VoidInvoiceResult> {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new BusinessRuleViolationError(
        'VOID_REASON_REQUIRED',
        'La anulación necesita un motivo',
      );
    }

    const result = await this.uow.execute(async () => {
      const now = this.clock.now();
      const invoice = await this.invoices.findByIdOrFail(input.invoiceId);
      if (invoice.status === 'VOID') {
        throw new ConflictError(
          'INVOICE_ALREADY_VOID',
          `La venta ${invoice.number} ya está anulada`,
          {
            invoiceId: invoice.id,
          },
        );
      }

      const payments = await this.payments.findByInvoiceId(invoice.id);
      const pending = payments.filter((payment) => payment.netAmount.isPositive());
      const cashRefunded = pending
        .filter((payment) => payment.isCash)
        .reduce((sum, payment) => sum.add(payment.netAmount), Money.zero(invoice.currency));

      // La caja se comprueba antes de tocar nada: sin ella no hay de dónde sacar el efectivo.
      const session = cashRefunded.isPositive() ? await this.sessions.findOpen() : null;
      if (cashRefunded.isPositive() && !session) {
        throw new BusinessRuleViolationError(
          'CASH_REFUND_REQUIRES_OPEN_SESSION',
          `La venta ${invoice.number} se cobró en efectivo: abre la caja para devolver ${cashRefunded.toString()}`,
          { invoiceId: invoice.id, cash: cashRefunded.toDecimalString() },
        );
      }

      for (const payment of pending) {
        const amount = payment.netAmount;
        payment.refund(amount, reason, now);
        await this.payments.update(payment);
        invoice.registerRefund(amount, now, input.actorId);
      }

      if (session) {
        const cashSales = await this.payments.cashTotalForSession(session.id, session.currency);
        session.recordRefund({
          id: this.ids.generate(),
          amount: cashRefunded,
          invoiceNumber: invoice.number,
          cashSales,
          now,
          actorId: input.actorId,
        });
        await this.sessions.update(session);
      }

      const appointmentId = invoice.appointmentId;
      invoice.void(reason, now, input.actorId);
      const voided = await this.invoices.update(invoice);

      const restocked = await this.returnStock.execute({
        tenantId: voided.tenantId,
        invoiceId: voided.id,
        invoiceNumber: voided.number,
        actorId: input.actorId,
      });

      // Las estadísticas de la clienta se sumaron al emitir; se restan al anular.
      if (voided.clientId) {
        const client = await this.clients.findByIdOrFail(voided.clientId);
        client.revertVisit(voided.total, now);
        await this.clients.update(client);
      }

      // Si la venta cobró comandas, vuelven a caja: el servicio se hizo igual y hay que
      // cobrarlo bien. Cobradas contra una factura anulada desaparecerían de caja.
      const charged = await this.tickets.findChargedByInvoiceId(voided.id);
      for (const ticket of charged) {
        ticket.reopen(now, input.actorId);
        await this.tickets.reopen(ticket);
      }

      return {
        invoice: voided,
        payments,
        cashRefunded,
        sessionId: session?.id ?? null,
        appointmentId,
        reopenedTicketIds: charged.map((ticket) => ticket.id),
        restocked: restocked.map((movement) => ({
          productId: movement.productId,
          batchId: movement.batchId,
          quantity: movement.quantityDelta,
        })),
      };
    });

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Invoice',
      entityId: result.invoice.id,
      after: {
        status: 'VOID',
        number: result.invoice.number,
        reason,
        refunded: result.payments.map((payment) => ({
          paymentId: payment.id,
          method: payment.method,
          amount: payment.refundedAmount.toDecimalString(),
        })),
        cashRefunded: result.cashRefunded.toDecimalString(),
        cashSessionId: result.sessionId,
        releasedAppointmentId: result.appointmentId,
        reopenedServiceTicketIds: result.reopenedTicketIds,
        restocked: result.restocked,
      },
    });

    return {
      invoice: result.invoice,
      payments: result.payments,
      cashRefunded: result.cashRefunded,
    };
  }
}

// ===========================================================================

/**
 * Rechaza el mismo artículo en dos líneas.
 *
 * Dos líneas del mismo producto no son un error aritmético —el total sale bien— pero
 * producen un ticket confuso y, sobre todo, dos descuentos de stock separados que en el
 * kardex parecen dos ventas. Agruparlas es también lo que espera quien lee la factura.
 *
 * Un servicio sí puede repetirse si lo hicieron profesionales distintas: el lavado de una
 * y el de otra son dos trabajos, con dos comisiones, y agruparlos obligaría a atribuir
 * ambos a una sola. No mueve stock, así que la razón del kardex no aplica.
 */
const assertNoRepeatedItems = (lines: readonly SaleLineInput[]): void => {
  const seen = new Set<string>();

  for (const line of lines) {
    const key =
      line.kind === 'SERVICE'
        ? `${line.kind}:${line.itemId}:${line.stylistId ?? ''}`
        : `${line.kind}:${line.itemId}`;
    if (seen.has(key)) {
      throw new ConflictError(
        'DUPLICATE_SALE_LINE',
        'Agrupe los productos o servicios repetidos en una sola línea',
        { itemId: line.itemId },
      );
    }
    seen.add(key);
  }
};
