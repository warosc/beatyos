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
import { BusinessRuleViolationError, ConflictError } from '../../../shared/domain/errors';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import { Category, type CategoryKindValue } from '../domain/category.entity';
import {
  CATEGORY_REPOSITORY,
  SERVICE_REPOSITORY,
  type CategoryFilter,
  type CategoryRepository,
  type CategorySortField,
  type ServiceFilter,
  type ServiceRepository,
  type ServiceSortField,
} from '../domain/catalog.repositories';
import { Service } from '../domain/service.entity';

// ===========================================================================
// Servicios
// ===========================================================================

export interface CreateServiceInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly price: string;
  readonly currency: string;
  readonly categoryId?: string | null;
  readonly description?: string | null;
  readonly bufferMinutes?: number;
  readonly taxRate?: number;
  readonly commissionRate?: number | null;
  readonly isBookableOnline?: boolean;
  readonly color?: string | null;
  readonly sortOrder?: number;
  readonly actorId: string | null;
}

@Injectable()
export class CreateServiceUseCase implements UseCase<CreateServiceInput, Service> {
  constructor(
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateServiceInput): Promise<Service> {
    const existing = await this.services.findByCode(input.code, { includeDeleted: true });
    if (existing) {
      throw new ConflictError(
        existing.isDeleted ? 'SERVICE_CODE_EXISTS_DELETED' : 'SERVICE_CODE_ALREADY_EXISTS',
        existing.isDeleted
          ? 'Existe un servicio eliminado con ese código. Recupérelo o use otro código.'
          : 'Ya existe un servicio con ese código',
        { serviceId: existing.id },
      );
    }

    if (input.categoryId) {
      await this.assertCategoryAccepts(input.categoryId, 'SERVICE');
    }

    const service = Service.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      code: input.code,
      name: input.name,
      durationMinutes: input.durationMinutes,
      price: Money.fromDecimal(input.price, input.currency),
      categoryId: input.categoryId ?? null,
      description: input.description ?? null,
      bufferMinutes: input.bufferMinutes,
      taxRate: input.taxRate === undefined ? undefined : Percentage.create(input.taxRate),
      commissionRate:
        input.commissionRate === null || input.commissionRate === undefined
          ? null
          : Percentage.create(input.commissionRate),
      isBookableOnline: input.isBookableOnline,
      color: input.color ?? null,
      sortOrder: input.sortOrder,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const saved = await this.services.create(service);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Service',
      entityId: saved.id,
      after: { code: saved.code, name: saved.name, price: saved.price.toDecimalString() },
    });

    return saved;
  }

  /**
   * Comprueba que la categoría existe y admite servicios.
   *
   * Sin esto se podría colgar un corte de pelo de «Coloración (productos)», y el catálogo
   * dejaría de tener sentido en cuanto alguien mirase el menú.
   */
  private async assertCategoryAccepts(categoryId: string, kind: CategoryKindValue): Promise<void> {
    const category = await this.categories.findByIdOrFail(categoryId);

    if (!category.accepts(kind)) {
      throw new BusinessRuleViolationError(
        'CATEGORY_KIND_MISMATCH',
        `La categoría "${category.name}" es de ${category.kind === 'SERVICE' ? 'servicios' : 'productos'} y no admite este elemento`,
        { categoryId, expected: kind, actual: category.kind },
      );
    }
  }
}

export interface UpdateServiceInput {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly categoryId?: string | null;
  readonly durationMinutes?: number;
  readonly bufferMinutes?: number;
  readonly taxRate?: number;
  readonly commissionRate?: number | null;
  readonly isBookableOnline?: boolean;
  readonly color?: string | null;
  readonly sortOrder?: number;
  readonly price?: string;
  readonly isActive?: boolean;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateServiceUseCase implements UseCase<UpdateServiceInput, Service> {
  constructor(
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: UpdateServiceInput): Promise<Service> {
    const now = this.clock.now();
    const service = await this.services.findByIdOrFail(input.id);

    const before = {
      name: service.name,
      price: service.price.toDecimalString(),
      durationMinutes: service.durationMinutes,
      isActive: service.isActive,
    };

    if (input.categoryId) {
      const category = await this.categories.findByIdOrFail(input.categoryId);
      if (!category.accepts('SERVICE')) {
        throw new BusinessRuleViolationError(
          'CATEGORY_KIND_MISMATCH',
          `La categoría "${category.name}" no admite servicios`,
        );
      }
    }

    service.updateDetails(
      {
        name: input.name,
        description: input.description,
        categoryId: input.categoryId,
        durationMinutes: input.durationMinutes,
        bufferMinutes: input.bufferMinutes,
        taxRate: input.taxRate === undefined ? undefined : Percentage.create(input.taxRate),
        commissionRate:
          input.commissionRate === undefined
            ? undefined
            : input.commissionRate === null
              ? null
              : Percentage.create(input.commissionRate),
        isBookableOnline: input.isBookableOnline,
        color: input.color,
        sortOrder: input.sortOrder,
      },
      now,
      input.actorId,
    );

    // El precio se cambia aparte: tiene consecuencias que un cambio de descripción no
    // tiene, y conviene que quede así de visible tanto en el código como en la auditoría.
    if (input.price !== undefined) {
      service.changePrice(
        Money.fromDecimal(input.price, service.price.currency),
        now,
        input.actorId,
      );
    }

    if (input.isActive !== undefined) {
      if (input.isActive) service.activate(now, input.actorId);
      else service.deactivate(now, input.actorId);
    }

    const saved = await this.services.update(service);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Service',
      entityId: saved.id,
      before,
      after: {
        name: saved.name,
        price: saved.price.toDecimalString(),
        durationMinutes: saved.durationMinutes,
        isActive: saved.isActive,
      },
    });

    return saved;
  }
}

export interface SetConsumablesInput {
  readonly serviceId: string;
  readonly consumables: readonly { productId: string; quantity: number }[];
  readonly actorId: string | null;
}

@Injectable()
export class SetServiceConsumablesUseCase implements UseCase<SetConsumablesInput, Service> {
  constructor(
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: SetConsumablesInput): Promise<Service> {
    const service = await this.services.findByIdOrFail(input.serviceId);

    service.replaceConsumables(input.consumables, this.clock.now(), input.actorId);
    const saved = await this.services.update(service);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Service',
      entityId: saved.id,
      metadata: { field: 'consumables', count: input.consumables.length },
    });

    return saved;
  }
}

@Injectable()
export class GetServiceUseCase implements UseCase<string, Service> {
  constructor(@Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository) {}

  execute(id: string): Promise<Service> {
    return this.services.findByIdOrFail(id);
  }
}

export interface SearchServicesInput {
  readonly filter: ServiceFilter;
  readonly page: PageRequest<ServiceSortField>;
  readonly includeDeleted?: boolean;
}

@Injectable()
export class SearchServicesUseCase implements UseCase<SearchServicesInput, Page<Service>> {
  constructor(@Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository) {}

  execute(input: SearchServicesInput): Promise<Page<Service>> {
    return this.services.search(input.filter, input.page, {
      includeDeleted: input.includeDeleted ?? false,
    });
  }
}

export interface EntityIdInput {
  readonly id: string;
  readonly actorId: string | null;
}

@Injectable()
export class DeleteServiceUseCase implements UseCase<EntityIdInput, void> {
  constructor(
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: EntityIdInput): Promise<void> {
    const service = await this.services.findByIdOrFail(input.id);
    await this.services.softDelete(input.id, input.actorId);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Service',
      entityId: input.id,
      before: { code: service.code, name: service.name },
    });
  }
}

@Injectable()
export class RestoreServiceUseCase implements UseCase<EntityIdInput, Service> {
  constructor(
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: EntityIdInput): Promise<Service> {
    const restored = await this.services.restore(input.id, input.actorId);
    await this.audit.record({ action: 'RESTORE', entityType: 'Service', entityId: input.id });
    return restored;
  }
}

// ===========================================================================
// Categorías
// ===========================================================================

export interface CreateCategoryInput {
  readonly tenantId: string;
  readonly kind: CategoryKindValue;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly color?: string | null;
  readonly parentId?: string | null;
  readonly sortOrder?: number;
  readonly actorId: string | null;
}

@Injectable()
export class CreateCategoryUseCase implements UseCase<CreateCategoryInput, Category> {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateCategoryInput): Promise<Category> {
    const now = this.clock.now();

    if (input.parentId) {
      const parent = await this.categories.findByIdOrFail(input.parentId);

      // Un árbol con ramas de distinto tipo sería incoherente: no se puede colgar una
      // categoría de productos de una de servicios.
      if (parent.kind !== input.kind) {
        throw new BusinessRuleViolationError(
          'CATEGORY_KIND_MISMATCH',
          'Una categoría no puede colgar de otra de distinto tipo',
          { parentKind: parent.kind, kind: input.kind },
        );
      }
    }

    const category = Category.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      kind: input.kind,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      color: input.color ?? null,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder,
      now,
      actorId: input.actorId,
    });

    // La profundidad se comprueba después de construir, porque necesita el id de la
    // categoría nueva para el chequeo de ciclo.
    if (input.parentId) {
      const ancestors = await this.categories.findAncestorIds(input.parentId);
      category.moveTo(input.parentId, ancestors, now, input.actorId);
    }

    const saved = await this.categories.create(category);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Category',
      entityId: saved.id,
      after: { name: saved.name, kind: saved.kind, slug: saved.slug },
    });

    return saved;
  }
}

export interface UpdateCategoryInput {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly color?: string | null;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
  /** `undefined` no toca el padre; `null` la convierte en raíz. */
  readonly parentId?: string | null;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateCategoryUseCase implements UseCase<UpdateCategoryInput, Category> {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: UpdateCategoryInput): Promise<Category> {
    const now = this.clock.now();
    const category = await this.categories.findByIdOrFail(input.id);

    category.updateDetails(
      {
        name: input.name,
        slug: input.slug,
        description: input.description,
        color: input.color,
        sortOrder: input.sortOrder,
      },
      now,
      input.actorId,
    );

    if (input.parentId !== undefined) {
      // La cadena de ascendientes se resuelve aquí y se le pasa al dominio: detectar el
      // ciclo es una regla de negocio, pero recorrer el árbol es trabajo de la base.
      const ancestors = input.parentId ? await this.categories.findAncestorIds(input.parentId) : [];
      category.moveTo(input.parentId, ancestors, now, input.actorId);
    }

    if (input.isActive !== undefined) {
      category.setActive(input.isActive, now, input.actorId);
    }

    const saved = await this.categories.update(category);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Category',
      entityId: saved.id,
      after: { name: saved.name, parentId: saved.parentId, isActive: saved.isActive },
    });

    return saved;
  }
}

export interface SearchCategoriesInput {
  readonly filter: CategoryFilter;
  readonly page: PageRequest<CategorySortField>;
  readonly includeDeleted?: boolean;
}

@Injectable()
export class SearchCategoriesUseCase implements UseCase<SearchCategoriesInput, Page<Category>> {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository) {}

  execute(input: SearchCategoriesInput): Promise<Page<Category>> {
    return this.categories.search(input.filter, input.page, {
      includeDeleted: input.includeDeleted ?? false,
    });
  }
}

@Injectable()
export class GetCategoryTreeUseCase implements UseCase<CategoryKindValue, Category[]> {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository) {}

  execute(kind: CategoryKindValue): Promise<Category[]> {
    return this.categories.findTree(kind);
  }
}

/**
 * Elimina una categoría.
 *
 * Se niega si cuelga algo de ella. La alternativa —borrar en cascada o dejar huérfanos—
 * es peor: en el primer caso desaparecen servicios sin que nadie lo pida, y en el segundo
 * quedan elementos invisibles en el menú que solo se descubren al echarlos en falta.
 */
@Injectable()
export class DeleteCategoryUseCase implements UseCase<EntityIdInput, void> {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: CategoryRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: EntityIdInput): Promise<void> {
    const category = await this.categories.findByIdOrFail(input.id);

    if (await this.categories.hasChildren(input.id)) {
      throw new BusinessRuleViolationError(
        'CATEGORY_NOT_EMPTY',
        'No se puede eliminar una categoría con subcategorías o elementos. Muévalos antes.',
        { categoryId: input.id },
      );
    }

    await this.categories.softDelete(input.id, input.actorId);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Category',
      entityId: input.id,
      before: { name: category.name, kind: category.kind },
    });
  }
}
