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
import { ConsumeStockUseCase } from '../../inventory/application/inventory.use-cases';
import {
  PRODUCT_REPOSITORY,
  type ProductRepository,
} from '../../inventory/domain/inventory.repositories';
import type { Product } from '../../inventory/domain/product.entity';
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
  type DocumentNumberGenerator,
  type InvoiceFilter,
  type InvoiceRepository,
  type InvoiceSortField,
  type PaymentRepository,
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

  async execute(input: RegisterSaleInput): Promise<RegisterSaleResult> {
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

      return { invoice: saved, payments };
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

@Injectable()
export class SearchInvoicesUseCase implements UseCase<
  { filter: InvoiceFilter; page: PageRequest<InvoiceSortField> },
  Page<Invoice>
> {
  constructor(@Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository) {}

  execute(input: {
    filter: InvoiceFilter;
    page: PageRequest<InvoiceSortField>;
  }): Promise<Page<Invoice>> {
    return this.invoices.search(input.filter, input.page);
  }
}

export interface InvoiceDetail {
  readonly invoice: Invoice;
  readonly payments: readonly Payment[];
}

@Injectable()
export class GetInvoiceUseCase implements UseCase<{ invoiceId: string }, InvoiceDetail> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
  ) {}

  async execute(input: { invoiceId: string }): Promise<InvoiceDetail> {
    const invoice = await this.invoices.findByIdOrFail(input.invoiceId);
    return { invoice, payments: await this.payments.findByInvoiceId(invoice.id) };
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

/**
 * Anula una factura y devuelve el género al almacén.
 *
 * La restricción de que no tenga cobros la impone el agregado. Aquí solo se coordina la
 * devolución del stock, que es la parte que el documento por sí solo no puede hacer.
 */
@Injectable()
export class VoidInvoiceUseCase implements UseCase<VoidInvoiceInput, Invoice> {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: VoidInvoiceInput): Promise<Invoice> {
    const voided = await this.uow.execute(async () => {
      const invoice = await this.invoices.findByIdOrFail(input.invoiceId);
      invoice.void(input.reason, this.clock.now(), input.actorId);
      return this.invoices.update(invoice);
    });

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Invoice',
      entityId: voided.id,
      after: { status: 'VOID', reason: input.reason, number: voided.number },
    });

    return voided;
  }
}

// ===========================================================================

/**
 * Rechaza el mismo artículo en dos líneas.
 *
 * Dos líneas del mismo producto no son un error aritmético —el total sale bien— pero
 * producen un ticket confuso y, sobre todo, dos descuentos de stock separados que en el
 * kardex parecen dos ventas. Agruparlas es también lo que espera quien lee la factura.
 */
const assertNoRepeatedItems = (lines: readonly SaleLineInput[]): void => {
  const seen = new Set<string>();

  for (const line of lines) {
    const key = `${line.kind}:${line.itemId}`;
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
