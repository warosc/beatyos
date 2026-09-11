import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '@shared/domain/ports/repository.port';
import { EntityNotFoundError } from '@shared/domain/errors';
import type { User } from '@core/users/domain/user.entity';
import type { UserFilter, UserRepository, UserSortField } from '@core/users/domain/user.repository';

/**
 * Doble en memoria del repositorio de usuarios (ADR-0009).
 *
 * No es un mock: es una **implementación de verdad** del puerto, con las mismas
 * invariantes que el adaptador de Prisma —unicidad de correo, filtro de borrados,
 * ámbito de salón—. La diferencia importa: un mock que devuelve lo que le digas
 * confirma que el caso de uso llama a un método, no que el caso de uso funcione. Con
 * esta implementación, un test que pasa aquí describe comportamiento real.
 *
 * La contrapartida es que puede desviarse del adaptador real. Por eso existe una batería
 * de tests de contrato que se ejecuta contra ambos (`test/contract/`).
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, User>();

  /** Salón activo simulado. `null` equivale a un contexto sin autenticar. */
  public currentTenantId: string | null = null;

  seed(...users: User[]): this {
    for (const user of users) this.store.set(user.id, user);
    return this;
  }

  get all(): User[] {
    return [...this.store.values()];
  }

  async findById(id: string, options?: QueryOptions): Promise<User | null> {
    const user = this.store.get(id);
    if (!user) return null;
    if (!this.visible(user, options)) return null;
    // Réplica del aislamiento por salón que aplica la extensión de Prisma: sin esto, un
    // test unitario pasaría y el mismo código fugaría datos en producción.
    if (this.currentTenantId !== null && user.tenantId !== this.currentTenantId) return null;
    return user;
  }

  async findByIdAcrossTenants(id: string): Promise<User | null> {
    const user = this.store.get(id);
    return user && this.visible(user) ? user : null;
  }

  async findByEmailAcrossTenants(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    return this.all.find((user) => this.visible(user) && user.email.value === normalized) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    return (
      this.all.find(
        (user) =>
          this.visible(user) &&
          user.email.value === normalized &&
          (this.currentTenantId === null || user.tenantId === this.currentTenantId),
      ) ?? null
    );
  }

  async search(
    filter: UserFilter,
    page: PageRequest<UserSortField>,
    options?: QueryOptions,
  ): Promise<Page<User>> {
    let matches = this.all.filter(
      (user) =>
        this.visible(user, options) &&
        (this.currentTenantId === null || user.tenantId === this.currentTenantId),
    );

    if (filter.status) matches = matches.filter((u) => u.status === filter.status);
    if (filter.roleCode) matches = matches.filter((u) => u.roleCodes.includes(filter.roleCode!));
    if (filter.search) {
      const term = filter.search.toLowerCase();
      matches = matches.filter(
        (u) => u.email.value.includes(term) || u.name.full.toLowerCase().includes(term),
      );
    }

    const criteria = page.sort?.length
      ? page.sort
      : [{ field: 'createdAt' as const, direction: 'desc' as const }];
    matches.sort((a, b) => {
      for (const { field, direction } of criteria) {
        const comparison = this.compare(a, b, field);
        if (comparison !== 0) return direction === 'asc' ? comparison : -comparison;
      }
      return 0;
    });

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(user: User): Promise<User> {
    this.store.set(user.id, user);
    return user;
  }

  async update(user: User): Promise<User> {
    if (!this.store.has(user.id)) {
      throw new EntityNotFoundError('Usuario', user.id);
    }
    this.store.set(user.id, user);
    return user;
  }

  async updateLoginState(user: User): Promise<void> {
    this.store.set(user.id, user);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.store.has(id)) throw new EntityNotFoundError('Usuario', id);
    // El doble no puede sellar la entidad porque el agregado no expone un `markDeleted`;
    // se retira del almacén, que a efectos de consulta es equivalente.
    this.store.delete(id);
  }

  async restore(id: string): Promise<User> {
    const user = this.store.get(id);
    if (!user) throw new EntityNotFoundError('Usuario eliminado', id);
    return user;
  }

  async existsByEmail(email: string, excludeId?: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    return this.all.some(
      (user) => this.visible(user) && user.email.value === normalized && user.id !== excludeId,
    );
  }

  async countActiveOwners(excludeUserId?: string): Promise<number> {
    return this.all.filter(
      (user) =>
        this.visible(user) &&
        user.isActive() &&
        user.id !== excludeUserId &&
        user.roleCodes.includes('OWNER') &&
        (this.currentTenantId === null || user.tenantId === this.currentTenantId),
    ).length;
  }

  private visible(user: User, options?: QueryOptions): boolean {
    return options?.includeDeleted === true || !user.isDeleted;
  }

  private compare(a: User, b: User, field: UserSortField): number {
    switch (field) {
      case 'email':
        return a.email.value.localeCompare(b.email.value);
      case 'lastName':
        return a.name.lastName.localeCompare(b.name.lastName);
      case 'status':
        return a.status.localeCompare(b.status);
      case 'lastLoginAt':
        return (a.lastLoginAt?.getTime() ?? 0) - (b.lastLoginAt?.getTime() ?? 0);
      case 'createdAt':
      default:
        return a.audit.createdAt.getTime() - b.audit.createdAt.getTime();
    }
  }
}
