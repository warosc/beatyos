import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  type Clock,
  type IdGenerator,
  ID_GENERATOR,
  type UseCase,
} from '../../../shared/application/ports';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Supplier, type SupplierContactChanges } from '../domain/supplier.entity';
import {
  SUPPLIER_REPOSITORY,
  type SupplierFilter,
  type SupplierRepository,
  type SupplierSortField,
} from '../domain/purchases.repositories';

/**
 * Casos de uso de proveedores (ADR-0017).
 *
 * Un caso de uso por intención, en lugar del `SuppliersService` con cinco métodos que
 * había antes. La diferencia no es estética: un servicio con todas las operaciones acumula
 * dependencias que solo la mitad de sus métodos usan, y acaba siendo el sitio donde cabe
 * cualquier cosa. Es el patrón que el resto del repositorio ya evita.
 */

// ---------------------------------------------------------------------------

export interface CreateSupplierInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly legalName?: string;
  readonly taxId?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly contactName?: string;
  readonly paymentTermDays?: number;
  readonly notes?: string;
  readonly actorId: string | null;
}

@Injectable()
export class CreateSupplierUseCase implements UseCase<CreateSupplierInput, Supplier> {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * No comprueba el código duplicado antes de escribir.
   *
   * La unicidad la sostiene el índice parcial `suppliers_tenant_code_uq`, y leerlo antes
   * abriría una ventana entre la comprobación y la inserción por la que dos altas
   * simultáneas pasarían las dos. El traductor de errores ya convierte esa restricción en
   * `SUPPLIER_CODE_ALREADY_EXISTS` con un 409; lo que faltaba era que compras pasara por
   * él, cosa que ahora hace a través del repositorio.
   */
  async execute(input: CreateSupplierInput): Promise<Supplier> {
    const supplier = Supplier.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      code: input.code,
      name: input.name,
      legalName: input.legalName,
      taxId: input.taxId,
      email: input.email,
      phone: input.phone,
      contactName: input.contactName,
      paymentTermDays: input.paymentTermDays,
      notes: input.notes,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    return this.suppliers.create(supplier);
  }
}

// ---------------------------------------------------------------------------

export interface UpdateSupplierInput {
  readonly supplierId: string;
  readonly changes: SupplierContactChanges;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateSupplierUseCase implements UseCase<UpdateSupplierInput, Supplier> {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: UpdateSupplierInput): Promise<Supplier> {
    const supplier = await this.suppliers.findByIdOrFail(input.supplierId);
    supplier.applyChanges(input.changes, this.clock.now(), input.actorId);
    return this.suppliers.update(supplier);
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class ListSuppliersUseCase implements UseCase<
  { filter: SupplierFilter; page: PageRequest<SupplierSortField> },
  Page<Supplier>
> {
  constructor(@Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository) {}

  execute(input: {
    filter: SupplierFilter;
    page: PageRequest<SupplierSortField>;
  }): Promise<Page<Supplier>> {
    return this.suppliers.search(input.filter, input.page);
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class DeleteSupplierUseCase implements UseCase<
  { supplierId: string; actorId: string | null },
  void
> {
  constructor(@Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository) {}

  execute(input: { supplierId: string; actorId: string | null }): Promise<void> {
    return this.suppliers.softDelete(input.supplierId, input.actorId);
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class RestoreSupplierUseCase implements UseCase<
  { supplierId: string; actorId: string | null },
  Supplier
> {
  constructor(@Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository) {}

  /**
   * El repositorio devuelve el proveedor ya reactivado.
   *
   * La reactivación es parte del agregado (`Supplier.markRestored`), no del adaptador:
   * recuperar una ficha que reaparece en el listado pero a la que no se puede pedir nada
   * es peor que no recuperarla, y esa regla debe valer para cualquier vía de restauración.
   */
  execute(input: { supplierId: string; actorId: string | null }): Promise<Supplier> {
    return this.suppliers.restore(input.supplierId, input.actorId);
  }
}
