import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PurchaseOrderLine as LineRow, Supplier as SupplierRow } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type SortCriterion,
} from '../../../../shared/domain/ports/repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../../shared/domain/value-objects/time-range.vo';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import {
  PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderStatusValue,
} from '../../domain/purchase-order.entity';
import type {
  PurchaseOrderFilter,
  PurchaseOrderNumberGenerator,
  PurchaseOrderRepository,
  PurchaseOrderSortField,
  SupplierFilter,
  SupplierRepository,
  SupplierSortField,
} from '../../domain/purchases.repositories';
import { Quantity } from '../../domain/quantity.vo';
import { Supplier } from '../../domain/supplier.entity';

/**
 * Adaptadores de persistencia de compras (ADR-0017).
 *
 * Aquí, y solo aquí, se conoce Prisma. Al heredar de `PrismaRepositoryBase` el módulo deja
 * de tener copia propia de la paginación, el soft delete, la restauración y —lo que en
 * compras faltaba de verdad— la **traducción de errores**: sin ella, dar de alta un
 * proveedor con un código repetido devolvía un 500 en lugar del 409 que el ADR-0008 promete
 * y que `suppliers_tenant_code_uq` ya tenía escrito en el traductor desde el principio.
 *
 * El `tenantId` no aparece en ningún `where` de este fichero. Lo inyecta la extensión de
 * Prisma por debajo (ADR-0003), y escribirlo a mano sería tanto ruido como riesgo: el día
 * que alguien lo omitiera, la consulta seguiría pareciendo correcta.
 */

// ===========================================================================
// Proveedores
// ===========================================================================

@Injectable()
export class PrismaSupplierRepository
  extends PrismaRepositoryBase<Supplier, SupplierRow, SupplierFilter, SupplierSortField>
  implements SupplierRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'supplier';
  protected readonly entityName = 'Proveedor';

  protected readonly sortableFields: ReadonlyMap<
    SupplierSortField,
    OrderByClause | OrderByClause[]
  > = new Map<SupplierSortField, OrderByClause | OrderByClause[]>([
    ['name', { name: true }],
    ['code', { code: true }],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort: readonly SortCriterion<SupplierSortField>[] = [
    { field: 'name', direction: 'asc' },
  ];

  async findAll(filter: SupplierFilter): Promise<Supplier[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.supplier.findMany({
        where: this.buildWhere(filter),
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  async findManyByIds(ids: readonly string[]): Promise<Supplier[]> {
    if (ids.length === 0) return [];
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.supplier.findMany({ where: { id: { in: [...ids] } } }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Da de alta el proveedor.
   *
   * `country` y `paymentTermDays` se omiten cuando el agregado los trae a `null`: así los
   * pone el esquema —GT y 30 días— y no hay una segunda copia de esos valores en el código
   * que olvidar el día que cambien.
   */
  async create(supplier: Supplier): Promise<Supplier> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.supplier.create({
        data: {
          id: supplier.id,
          tenantId: supplier.tenantId,
          code: supplier.code,
          name: supplier.name,
          legalName: supplier.legalName,
          taxId: supplier.taxId,
          email: supplier.email,
          phone: supplier.phone,
          contactName: supplier.contactName,
          addressLine: supplier.addressLine,
          city: supplier.city,
          postalCode: supplier.postalCode,
          ...(supplier.country === null ? {} : { country: supplier.country }),
          ...(supplier.paymentTermDays === null
            ? {}
            : { paymentTermDays: supplier.paymentTermDays }),
          notes: supplier.notes,
          status: supplier.status,
          createdAt: supplier.audit.createdAt,
          updatedAt: supplier.audit.updatedAt,
          createdBy: supplier.audit.createdBy,
          updatedBy: supplier.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  async update(supplier: Supplier): Promise<Supplier> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.supplier.updateMany({
        where: { id: supplier.id },
        data: {
          name: supplier.name,
          legalName: supplier.legalName,
          taxId: supplier.taxId,
          email: supplier.email,
          phone: supplier.phone,
          contactName: supplier.contactName,
          addressLine: supplier.addressLine,
          city: supplier.city,
          postalCode: supplier.postalCode,
          ...(supplier.paymentTermDays === null
            ? {}
            : { paymentTermDays: supplier.paymentTermDays }),
          notes: supplier.notes,
          status: supplier.status,
          deletedAt: supplier.audit.deletedAt,
          deletedBy: supplier.audit.deletedBy,
          updatedAt: supplier.audit.updatedAt,
          updatedBy: supplier.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, supplier.id);
    }

    return this.findByIdOrFail(supplier.id, { includeDeleted: supplier.isDeleted });
  }

  async save(supplier: Supplier): Promise<Supplier> {
    return this.update(supplier);
  }

  /**
   * Restaura y **reactiva**.
   *
   * `PrismaRepositoryBase.restore` solo limpia `deletedAt`, y no puede saber que en este
   * agregado dar de baja también deja al proveedor sin poder recibir pedidos. Es el mismo
   * fallo que el ADR-0013 encontró al recuperar un producto, y se resuelve igual: pasando
   * por la entidad, de modo que la regla siga viviendo en el dominio.
   */
  override async restore(id: string, actorId: string | null): Promise<Supplier> {
    return QueryScopeStore.includingDeleted(async () => {
      const supplier = await this.findById(id, { includeDeleted: true });
      if (!supplier || !supplier.isDeleted) {
        throw new EntityNotFoundError(`${this.entityName} eliminado`, id);
      }

      supplier.markRestored(this.clock.now(), actorId);
      return this.update(supplier);
    });
  }

  protected buildWhere(filter: SupplierFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['name', 'code']),
      filter.status ? { status: filter.status } : undefined,
    );
  }

  protected toDomain(row: SupplierRow): Supplier {
    return Supplier.rehydrate(row.id, {
      tenantId: row.tenantId,
      code: row.code,
      name: row.name,
      legalName: row.legalName,
      taxId: row.taxId,
      email: row.email,
      phone: row.phone,
      contactName: row.contactName,
      addressLine: row.addressLine,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      paymentTermDays: row.paymentTermDays,
      notes: row.notes,
      status: row.status,
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
}

// ===========================================================================
// Pedidos de compra
// ===========================================================================

/**
 * Las líneas se ordenan por identificador.
 *
 * Los identificadores son UUIDv7, ordenados en el tiempo (ADR-0002), así que el orden
 * ascendente es el de creación: el mismo en el que llegaron en la petición. Sin un
 * `orderBy` explícito, PostgreSQL puede devolverlas en cualquier orden, y una interfaz que
 * pinta la primera línea de un pedido no debería depender del plan de ejecución.
 */
const ORDER_INCLUDE = {
  lines: { orderBy: { id: 'asc' as const } },
} satisfies Prisma.PurchaseOrderInclude;

type OrderWithLines = Prisma.PurchaseOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

@Injectable()
export class PrismaPurchaseOrderRepository implements PurchaseOrderRepository {
  private readonly entityName = 'Pedido de compra';
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  async findById(id: string): Promise<PurchaseOrder | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrder.findFirst({ where: { id }, include: ORDER_INCLUDE }),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<PurchaseOrder | null> {
    const tenantId = RequestContextStore.tenantId;
    if (!tenantId) {
      // Conserva el error de ámbito que aplica la extensión cuando falta el tenant.
      return this.findById(id);
    }

    const rows = await withMappedErrors(
      this.entityName,
      () =>
        this.prisma.client.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "purchase_orders"
        WHERE "id" = ${id}
          AND "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `,
    );

    return rows.length > 0 ? this.findById(id) : null;
  }

  async findByIdOrFail(id: string): Promise<PurchaseOrder> {
    const order = await this.findById(id);
    if (!order) throw new EntityNotFoundError(this.entityName, id);
    return order;
  }

  async search(
    filter: PurchaseOrderFilter,
    page: PageRequest<PurchaseOrderSortField>,
  ): Promise<Page<PurchaseOrder>> {
    const where = filter.status ? { status: filter.status } : {};
    const orderBy = this.purchaseOrderSort(page.sort);
    const skip = (page.page - 1) * page.limit;
    const [total, rows] = await withMappedErrors(this.entityName, () =>
      Promise.all([
        this.prisma.client.purchaseOrder.count({ where }),
        this.prisma.client.purchaseOrder.findMany({
          where,
          include: ORDER_INCLUDE,
          orderBy,
          skip,
          take: page.limit,
        }),
      ]),
    );
    return buildPage(
      rows.map((row) => this.toDomain(row)),
      total,
      page,
    );
  }

  private purchaseOrderSort(
    sort?: readonly SortCriterion<PurchaseOrderSortField>[],
  ): Prisma.PurchaseOrderOrderByWithRelationInput[] {
    const criteria = sort?.length ? sort : [{ field: 'createdAt', direction: 'desc' } as const];
    return criteria.map(({ field, direction }) => ({ [field]: direction }));
  }

  /**
   * Crea la cabecera y sus líneas en una sola escritura anidada.
   *
   * Prisma la resuelve dentro de una transacción implícita, de modo que no puede quedar un
   * pedido sin líneas: sería un documento con un total que ningún desglose justifica.
   */
  async create(order: PurchaseOrder): Promise<PurchaseOrder> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrder.create({
        data: {
          id: order.id,
          tenantId: order.tenantId,
          supplierId: order.supplierId,
          number: order.number,
          status: order.status,
          orderedAt: order.orderedAt,
          expectedAt: order.expectedAt,
          receivedAt: order.receivedAt,
          supplierReference: order.supplierReference,
          notes: order.notes,
          subtotal: order.subtotal.toDecimalString(),
          taxTotal: order.taxTotal.toDecimalString(),
          total: order.total.toDecimalString(),
          currency: order.currency,
          createdAt: order.audit.createdAt,
          updatedAt: order.audit.updatedAt,
          createdBy: order.audit.createdBy,
          updatedBy: order.audit.updatedBy,
          lines: {
            create: order.lines.map((line) => ({
              id: line.id,
              tenantId: order.tenantId,
              productId: line.productId,
              quantity: line.quantity.toDecimalString(),
              receivedQuantity: line.receivedQuantity.toDecimalString(),
              unitCost: line.unitCost.toDecimalString(),
              taxRate: line.taxRate.value.toFixed(2),
              lineTotal: line.lineTotal.toDecimalString(),
              currency: line.lineTotal.currency,
              notes: line.notes,
              createdAt: line.createdAt,
              updatedAt: line.updatedAt,
            })),
          },
        },
        include: ORDER_INCLUDE,
      }),
    );
    return this.toDomain(row);
  }

  async markSubmitted(id: string, at: Date, actorId: string | null): Promise<boolean> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrder.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'SUBMITTED', orderedAt: at, updatedAt: at, updatedBy: actorId },
      }),
    );
    return result.count > 0;
  }

  async markCancelled(
    id: string,
    reason: string,
    at: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrder.updateMany({
        where: { id, status: { in: ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: at,
          cancellationReason: reason,
          updatedAt: at,
          updatedBy: actorId,
        },
      }),
    );
    return result.count > 0;
  }

  /**
   * Suma a lo recibido solo si cabe.
   *
   * El umbral `quantity − :q` se calcula con la cantidad pedida que trae el agregado, y no
   * con una lectura propia, porque esa cifra es inmutable: ningún endpoint modifica la
   * cantidad de una línea después de crear el pedido. Lo que sí se mueve —`receivedQuantity`—
   * queda dentro de la condición del `UPDATE`, de modo que comprobación y escritura ocurren
   * bajo el mismo bloqueo de fila.
   */
  async receiveLine(line: PurchaseOrderLine, quantity: Quantity, at: Date): Promise<boolean> {
    const threshold = line.quantity.subtract(quantity);
    if (threshold.isNegative()) return false;

    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrderLine.updateMany({
        where: { id: line.id, receivedQuantity: { lte: threshold.toDecimalString() } },
        data: { receivedQuantity: { increment: quantity.toDecimalString() }, updatedAt: at },
      }),
    );
    return result.count > 0;
  }

  async settleReceipt(
    id: string,
    status: PurchaseOrderStatusValue,
    receivedAt: Date | null,
    at: Date,
    actorId: string | null,
  ): Promise<void> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.purchaseOrder.updateMany({
        where: { id },
        data: { status, receivedAt, updatedAt: at, updatedBy: actorId },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, id);
    }
  }

  private toDomain(row: OrderWithLines): PurchaseOrder {
    const currency = row.currency || this.currency;

    return PurchaseOrder.rehydrate(row.id, {
      tenantId: row.tenantId,
      supplierId: row.supplierId,
      number: row.number,
      status: row.status,
      orderedAt: row.orderedAt,
      expectedAt: row.expectedAt,
      receivedAt: row.receivedAt,
      cancelledAt: row.cancelledAt,
      cancellationReason: row.cancellationReason,
      supplierReference: row.supplierReference,
      notes: row.notes,
      lines: row.lines.map((line) => this.lineToDomain(line, currency)),
      subtotal: Money.fromDecimal(row.subtotal.toFixed(2), currency),
      taxTotal: Money.fromDecimal(row.taxTotal.toFixed(2), currency),
      total: Money.fromDecimal(row.total.toFixed(2), currency),
      currency,
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

  private lineToDomain(row: LineRow, orderCurrency: string): PurchaseOrderLine {
    const currency = row.currency || orderCurrency;
    const quantity = Quantity.fromDecimal(row.quantity.toFixed(3));
    const unitCost = Money.fromDecimal(row.unitCost.toFixed(2), currency);

    return {
      id: row.id,
      productId: row.productId,
      quantity,
      receivedQuantity: Quantity.fromDecimal(row.receivedQuantity.toFixed(3)),
      unitCost,
      taxRate: Percentage.create(Number(row.taxRate)),
      // La base no guarda la base imponible de la línea, solo su total. Se recompone con la
      // misma operación con la que se calculó, así que el valor es el mismo que se guardó.
      lineSubtotal: unitCost.multiply(quantity.toNumber()),
      lineTotal: Money.fromDecimal(row.lineTotal.toFixed(2), currency),
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ===========================================================================
// Numeración
// ===========================================================================

/**
 * Numerador de pedidos de compra.
 *
 * El `upsert` con `increment` reserva el número en una sola sentencia y va dentro de la
 * transacción que crea el pedido: si el pedido no llega a existir, el contador vuelve atrás
 * con ella y no queda hueco en la serie. Es la razón de que esto no se pueda resolver con
 * un `SELECT max(number) + 1`, que produce duplicados en cuanto hay dos altas a la vez.
 */
@Injectable()
export class PrismaPurchaseOrderNumberGenerator implements PurchaseOrderNumberGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async next(year: number): Promise<string> {
    const tenantId = RequestContextStore.tenantId;
    if (!tenantId) {
      throw new EntityNotFoundError('Serie de numeración', `PURCHASE_ORDER:${year}`);
    }

    const sequence = await withMappedErrors('Serie de numeración', () =>
      this.prisma.client.documentSequence.upsert({
        where: {
          tenantId_documentType_year: { tenantId, documentType: 'PURCHASE_ORDER', year },
        },
        create: {
          tenantId,
          documentType: 'PURCHASE_ORDER',
          year,
          prefix: 'OC',
          lastNumber: 1,
        },
        update: { lastNumber: { increment: 1 } },
      }),
    );

    return `${sequence.prefix}-${year}-${String(sequence.lastNumber).padStart(6, '0')}`;
  }
}
