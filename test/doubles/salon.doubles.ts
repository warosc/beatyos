import { buildPage, type Page, type PageRequest } from '@shared/domain/ports/repository.port';
import { EntityNotFoundError } from '@shared/domain/errors';
import type { TimeRange } from '@shared/domain/value-objects/time-range.vo';
import { BLOCKING_STATUSES, type Appointment } from '@salon/appointments/domain/appointment.entity';
import type {
  AppointmentFilter,
  AppointmentRepository,
  AppointmentSortField,
} from '@salon/appointments/domain/appointment.repository';
import type { Category } from '@salon/catalog/domain/category.entity';
import type {
  CategoryFilter,
  CategoryRepository,
  CategorySortField,
  ServiceFilter,
  ServiceRepository,
  ServiceSortField,
} from '@salon/catalog/domain/catalog.repositories';
import type { Service } from '@salon/catalog/domain/service.entity';
import type { Stylist } from '@salon/stylists/domain/stylist.entity';
import type {
  StylistFilter,
  StylistRepository,
  StylistSortField,
} from '@salon/stylists/domain/stylist.repository';

/**
 * Dobles en memoria de los repositorios del salón (ADR-0009).
 *
 * Son implementaciones reales de cada puerto, no mocks: respetan las mismas invariantes
 * que sus adaptadores de Prisma —soft delete, unicidad, semántica de solapamiento— para
 * que un test que pasa aquí describa comportamiento y no la forma de una llamada.
 *
 * La pieza delicada es `findBlockingInRange`: replica exactamente la condición
 * `startsAt < fin AND endsAt > inicio` del SQL. Con un `<=` de más, dos citas
 * consecutivas se considerarían solapadas y el doble mentiría sobre la regla más
 * importante de la agenda.
 */

/** Superficie de soft delete que comparten los agregados del salon. */
interface SoftDeletable {
  markDeleted(now: Date, actorId: string | null): void;
  markRestored(now: Date, actorId: string | null): void;
}

abstract class InMemoryStore<T extends { id: string }> {
  protected readonly items = new Map<string, T>();

  /**
   * Identificadores dados de baja.
   *
   * El soft delete se emula con un conjunto aparte y **no** retirando la fila del mapa.
   * La primera version de estos dobles si la retiraba, y eso los hacia mentir: el
   * adaptador real sella `deletedAt` y sigue devolviendo el registro cuando se pide
   * `includeDeleted`, de modo que un test de «recuperar lo eliminado» pasaba contra
   * Prisma y fallaba aqui. Un doble que se desvia del contrato del puerto deja de probar
   * nada (ADR-0009).
   */
  protected readonly deletedIds = new Set<string>();

  seed(...entities: T[]): this {
    for (const entity of entities) this.items.set(entity.id, entity);
    return this;
  }

  /** Todo lo vivo. Es lo que ve una consulta normal. */
  get all(): T[] {
    return [...this.items.values()].filter((entity) => !this.deletedIds.has(entity.id));
  }

  /** Incluye los dados de baja. Solo para las consultas que lo piden expresamente. */
  get allIncludingDeleted(): T[] {
    return [...this.items.values()];
  }

  protected markDeleted(id: string): void {
    this.deletedIds.add(id);
    // Se sella tambien el agregado: el adaptador real lo rehidrata con `deletedAt`
    // puesto, y un doble que no lo hiciera mentiria sobre `isDeleted`.
    const entity = this.items.get(id) as unknown as SoftDeletable | undefined;
    entity?.markDeleted(new Date(), 'test');
  }

  protected markRestored(id: string): void {
    this.deletedIds.delete(id);
    const entity = this.items.get(id) as unknown as SoftDeletable | undefined;
    entity?.markRestored(new Date(), 'test');
  }

  protected isSoftDeleted(id: string): boolean {
    return this.deletedIds.has(id);
  }

  clear(): void {
    this.items.clear();
    this.deletedIds.clear();
  }
}

export class InMemoryStylistRepository extends InMemoryStore<Stylist> implements StylistRepository {
  async findById(id: string): Promise<Stylist | null> {
    const stylist = this.items.get(id);
    return stylist && !this.isSoftDeleted(id) ? stylist : null;
  }

  async findByIdOrFail(id: string): Promise<Stylist> {
    const stylist = await this.findById(id);
    if (!stylist) throw new EntityNotFoundError('Profesional', id);
    return stylist;
  }

  async findByUserId(userId: string): Promise<Stylist | null> {
    return this.all.find((stylist) => stylist.userId === userId) ?? null;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.findById(id)) !== null;
  }

  async count(filter: StylistFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(filter: StylistFilter, page: PageRequest<StylistSortField>): Promise<Page<Stylist>> {
    let matches = this.all;

    if (filter.status) matches = matches.filter((s) => s.status === filter.status);
    if (filter.onlyBookable) matches = matches.filter((s) => s.isBookable());
    if (filter.canPerformServiceId) {
      matches = matches.filter((s) => s.canPerform(filter.canPerformServiceId!));
    }
    if (filter.search) {
      const term = filter.search.toLowerCase();
      matches = matches.filter((s) => s.name.full.toLowerCase().includes(term));
    }

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(stylist: Stylist): Promise<Stylist> {
    this.items.set(stylist.id, stylist);
    return stylist;
  }

  async update(stylist: Stylist): Promise<Stylist> {
    if (!this.items.has(stylist.id)) throw new EntityNotFoundError('Profesional', stylist.id);
    this.items.set(stylist.id, stylist);
    return stylist;
  }

  async save(stylist: Stylist): Promise<Stylist> {
    return this.update(stylist);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id) || this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Profesional', id);
    }
    this.markDeleted(id);
  }

  async restore(id: string): Promise<Stylist> {
    const stylist = this.items.get(id);
    if (!stylist || !this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Profesional eliminado', id);
    }
    this.markRestored(id);
    return stylist;
  }
}

export class InMemoryServiceRepository extends InMemoryStore<Service> implements ServiceRepository {
  async findById(id: string): Promise<Service | null> {
    const service = this.items.get(id);
    return service && !this.isSoftDeleted(id) ? service : null;
  }

  async findByIdOrFail(id: string): Promise<Service> {
    const service = await this.findById(id);
    if (!service) throw new EntityNotFoundError('Servicio', id);
    return service;
  }

  async findByCode(code: string, options?: { includeDeleted?: boolean }): Promise<Service | null> {
    const normalized = code.trim().toUpperCase();
    const pool = options?.includeDeleted === true ? this.allIncludingDeleted : this.all;
    return pool.find((service) => service.code === normalized) ?? null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Service[]> {
    // Devuelve solo los encontrados, igual que el adaptador real: comprobar que no falta
    // ninguno es cosa del caso de uso.
    return ids
      .map((id) => this.items.get(id))
      .filter(
        (service): service is Service => service !== undefined && !this.isSoftDeleted(service.id),
      );
  }

  async exists(id: string): Promise<boolean> {
    return (await this.findById(id)) !== null;
  }

  async count(filter: ServiceFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(filter: ServiceFilter, page: PageRequest<ServiceSortField>): Promise<Page<Service>> {
    let matches = this.all;

    if (filter.isActive !== undefined)
      matches = matches.filter((s) => s.isActive === filter.isActive);
    if (filter.categoryId) matches = matches.filter((s) => s.categoryId === filter.categoryId);
    if (filter.maxDurationMinutes !== undefined) {
      matches = matches.filter((s) => s.durationMinutes <= filter.maxDurationMinutes!);
    }
    if (filter.search) {
      const term = filter.search.toLowerCase();
      matches = matches.filter(
        (s) => s.name.toLowerCase().includes(term) || s.code.toLowerCase().includes(term),
      );
    }

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(service: Service): Promise<Service> {
    this.items.set(service.id, service);
    return service;
  }

  async update(service: Service): Promise<Service> {
    if (!this.items.has(service.id)) throw new EntityNotFoundError('Servicio', service.id);
    this.items.set(service.id, service);
    return service;
  }

  async save(service: Service): Promise<Service> {
    return this.update(service);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id) || this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Servicio', id);
    }
    this.markDeleted(id);
  }

  async restore(id: string): Promise<Service> {
    const service = this.items.get(id);
    if (!service || !this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Servicio eliminado', id);
    }
    this.markRestored(id);
    return service;
  }
}

export class InMemoryCategoryRepository
  extends InMemoryStore<Category>
  implements CategoryRepository
{
  async findById(id: string): Promise<Category | null> {
    return this.items.get(id) ?? null;
  }

  async findByIdOrFail(id: string): Promise<Category> {
    const category = await this.findById(id);
    if (!category) throw new EntityNotFoundError('Categoría', id);
    return category;
  }

  async findAncestorIds(categoryId: string): Promise<string[]> {
    const ancestors: string[] = [];
    let current = this.items.get(categoryId);

    // Tope de profundidad por el mismo motivo que el adaptador real: un ciclo ya presente
    // en los datos colgaría el bucle.
    for (let depth = 0; depth < 10 && current?.parentId; depth += 1) {
      ancestors.unshift(current.parentId);
      current = this.items.get(current.parentId);
    }

    return ancestors;
  }

  async hasChildren(categoryId: string): Promise<boolean> {
    return this.all.some((category) => category.parentId === categoryId);
  }

  async findTree(kind: Category['kind']): Promise<Category[]> {
    return this.all.filter((category) => category.kind === kind);
  }

  async exists(id: string): Promise<boolean> {
    return this.items.has(id);
  }

  async count(filter: CategoryFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(
    filter: CategoryFilter,
    page: PageRequest<CategorySortField>,
  ): Promise<Page<Category>> {
    let matches = this.all;
    if (filter.kind) matches = matches.filter((c) => c.kind === filter.kind);
    if (filter.isActive !== undefined)
      matches = matches.filter((c) => c.isActive === filter.isActive);

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(category: Category): Promise<Category> {
    this.items.set(category.id, category);
    return category;
  }

  async update(category: Category): Promise<Category> {
    this.items.set(category.id, category);
    return category;
  }

  async save(category: Category): Promise<Category> {
    return this.update(category);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id)) throw new EntityNotFoundError('Categoría', id);
    this.items.delete(id);
  }

  async restore(id: string): Promise<Category> {
    const category = this.items.get(id);
    if (!category) throw new EntityNotFoundError('Categoría eliminada', id);
    return category;
  }
}

export class InMemoryAppointmentRepository
  extends InMemoryStore<Appointment>
  implements AppointmentRepository
{
  async findById(id: string): Promise<Appointment | null> {
    const appointment = this.items.get(id);
    return appointment && !this.isSoftDeleted(id) ? appointment : null;
  }

  async findByIdOrFail(id: string): Promise<Appointment> {
    const appointment = await this.findById(id);
    if (!appointment) throw new EntityNotFoundError('Cita', id);
    return appointment;
  }

  /**
   * Réplica exacta de la condición SQL de solapamiento.
   *
   * `startsAt < fin AND endsAt > inicio`, sin `=` en ningún extremo. Con `<=` de más, dos
   * citas consecutivas se considerarían solapadas y este doble mentiría sobre la regla
   * más importante de la agenda.
   */
  async findBlockingInRange(
    stylistId: string,
    range: TimeRange,
    excludeAppointmentId?: string,
  ): Promise<Appointment[]> {
    return this.all.filter(
      (appointment) =>
        appointment.stylistId === stylistId &&
        BLOCKING_STATUSES.includes(appointment.status) &&
        appointment.id !== excludeAppointmentId &&
        appointment.period.startsAt < range.endsAt &&
        appointment.period.endsAt > range.startsAt,
    );
  }

  async findForCalendar(range: TimeRange, stylistIds?: readonly string[]): Promise<Appointment[]> {
    return this.all
      .filter(
        (appointment) =>
          appointment.period.startsAt < range.endsAt &&
          appointment.period.endsAt > range.startsAt &&
          (!stylistIds || stylistIds.length === 0 || stylistIds.includes(appointment.stylistId)),
      )
      .sort((a, b) => a.period.startsAt.getTime() - b.period.startsAt.getTime());
  }

  async exists(id: string): Promise<boolean> {
    return (await this.findById(id)) !== null;
  }

  async count(filter: AppointmentFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(
    filter: AppointmentFilter,
    page: PageRequest<AppointmentSortField>,
  ): Promise<Page<Appointment>> {
    let matches = this.all;

    if (filter.stylistId) matches = matches.filter((a) => a.stylistId === filter.stylistId);
    if (filter.clientId) matches = matches.filter((a) => a.clientId === filter.clientId);
    if (filter.status) matches = matches.filter((a) => a.status === filter.status);
    if (filter.onlyBlocking) matches = matches.filter((a) => a.isBlocking);
    if (filter.from) matches = matches.filter((a) => a.period.endsAt > filter.from!);
    if (filter.to) matches = matches.filter((a) => a.period.startsAt < filter.to!);

    matches.sort((a, b) => a.period.startsAt.getTime() - b.period.startsAt.getTime());

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(appointment: Appointment): Promise<Appointment> {
    this.items.set(appointment.id, appointment);
    return appointment;
  }

  async update(appointment: Appointment): Promise<Appointment> {
    if (!this.items.has(appointment.id)) throw new EntityNotFoundError('Cita', appointment.id);
    this.items.set(appointment.id, appointment);
    return appointment;
  }

  async save(appointment: Appointment): Promise<Appointment> {
    return this.update(appointment);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id) || this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Cita', id);
    }
    this.markDeleted(id);
  }

  async restore(id: string): Promise<Appointment> {
    const appointment = this.items.get(id);
    if (!appointment || !this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Cita eliminada', id);
    }
    this.markRestored(id);
    return appointment;
  }
}

/**
 * Unidad de trabajo que no abre transacción.
 *
 * Los dobles guardan en memoria y no hay nada que confirmar ni deshacer. Lo importante es
 * que el caso de uso siga pasando por el puerto: así se comprueba que **usa** la unidad
 * de trabajo, aunque aquí no haga nada.
 */
export const passthroughUnitOfWork = {
  execute: <T>(work: () => Promise<T>): Promise<T> => work(),
};
