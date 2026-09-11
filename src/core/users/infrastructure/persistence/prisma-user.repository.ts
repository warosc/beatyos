import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '../../../../shared/domain/ports/repository.port';
import { Email, PersonName, Phone } from '../../../../shared/domain/value-objects/contact.vo';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import { User, type AssignedRole } from '../../domain/user.entity';
import type { UserFilter, UserRepository, UserSortField } from '../../domain/user.repository';

/**
 * Adaptador Prisma del repositorio de usuarios.
 *
 * No hereda de `PrismaRepositoryBase` a propósito: la identidad tiene particularidades
 * que la base no cubre —consultas entre inquilinos, `tenantId` opcional para las cuentas
 * de plataforma y una tabla puente de roles que hay que sincronizar—. Forzar la herencia
 * obligaría a llenar la clase base de excepciones para un único caso, que es cómo una
 * abstracción útil se convierte en un estorbo.
 *
 * El resto de repositorios sí la usan, que es donde está el ahorro real.
 */

/** Consulta con los roles y sus permisos: es lo mínimo para poder firmar un JWT. */
const USER_WITH_ROLES = {
  roles: {
    include: {
      role: {
        include: {
          permissions: { include: { permission: { select: { code: true } } } },
        },
      },
    },
  },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_WITH_ROLES }>;

const SORT_COLUMNS: Record<UserSortField, keyof Prisma.UserOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  lastName: 'lastName',
  email: 'email',
  lastLoginAt: 'lastLoginAt',
  status: 'status',
};

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // -- Lecturas -------------------------------------------------------------

  async findById(id: string, options?: QueryOptions): Promise<User | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors('Usuario', () =>
        this.prisma.client.user.findFirst({ where: { id }, include: USER_WITH_ROLES }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByIdAcrossTenants(id: string): Promise<User | null> {
    const row = await QueryScopeStore.crossTenant(() =>
      withMappedErrors('Usuario', () =>
        this.prisma.client.user.findFirst({ where: { id }, include: USER_WITH_ROLES }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  /**
   * Búsqueda por correo sin filtro de salón: el login solo tiene el correo y todavía no
   * sabe a qué inquilino pertenece (ADR-0003). La excepción al aislamiento queda
   * confinada aquí, no en el caso de uso.
   */
  async findByEmailAcrossTenants(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    const row = await QueryScopeStore.crossTenant(() =>
      withMappedErrors('Usuario', () =>
        this.prisma.client.user.findFirst({
          // `mode: insensitive` acompaña al índice único parcial sobre `lower(email)`:
          // el usuario que escribe "Ana@" debe encontrar su cuenta creada como "ana@".
          where: { email: { equals: normalized, mode: 'insensitive' } },
          include: USER_WITH_ROLES,
        }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await withMappedErrors('Usuario', () =>
      this.prisma.client.user.findFirst({
        where: { email: { equals: email.trim().toLowerCase(), mode: 'insensitive' } },
        include: USER_WITH_ROLES,
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  async search(
    filter: UserFilter,
    page: PageRequest<UserSortField>,
    options?: QueryOptions,
  ): Promise<Page<User>> {
    const where = this.buildWhere(filter);
    const orderBy = (
      page.sort?.length ? page.sort : [{ field: 'createdAt' as const, direction: 'desc' as const }]
    ).map(({ field, direction }) => ({ [SORT_COLUMNS[field] ?? 'createdAt']: direction }));

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors('Usuario', () =>
        Promise.all([
          this.prisma.client.user.count({ where }),
          this.prisma.client.user.findMany({
            where,
            orderBy,
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: USER_WITH_ROLES,
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

  async existsByEmail(email: string, excludeId?: string): Promise<boolean> {
    const count = await QueryScopeStore.crossTenant(() =>
      this.prisma.client.user.count({
        where: {
          email: { equals: email.trim().toLowerCase(), mode: 'insensitive' },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      }),
    );
    return count > 0;
  }

  async countActiveOwners(excludeUserId?: string): Promise<number> {
    return withMappedErrors('Usuario', () =>
      this.prisma.client.user.count({
        where: {
          status: 'ACTIVE',
          ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
          roles: { some: { role: { code: 'OWNER' } } },
        },
      }),
    );
  }

  // -- Escrituras -----------------------------------------------------------

  async create(user: User): Promise<User> {
    const row = await withMappedErrors('Usuario', () =>
      this.prisma.client.user.create({
        data: {
          id: user.id,
          tenantId: user.tenantId,
          ...this.toPersistence(user),
          createdAt: user.audit.createdAt,
          updatedAt: user.audit.updatedAt,
          createdBy: user.audit.createdBy,
          updatedBy: user.audit.updatedBy,
          roles: {
            create: user.roles.map((role) => ({
              roleId: role.id,
              assignedBy: user.audit.createdBy,
            })),
          },
        },
        include: USER_WITH_ROLES,
      }),
    );
    return this.toDomain(row);
  }

  /**
   * Actualiza el agregado completo, roles incluidos.
   *
   * La sincronización de roles es un borrado y alta dentro de la **misma transacción**:
   * calcular el diff mínimo sería más eficiente, pero un usuario tiene dos o tres roles y
   * la complejidad no compensa. Lo que sí es innegociable es la atomicidad —quedarse a
   * medias dejaría al usuario sin ningún rol y, por tanto, sin acceso.
   */
  async update(user: User): Promise<User> {
    return this.prisma.transaction(async () => {
      const row = await withMappedErrors('Usuario', async () => {
        const result = await this.prisma.client.user.updateMany({
          where: { id: user.id },
          data: {
            ...this.toPersistence(user),
            updatedAt: user.audit.updatedAt,
            updatedBy: user.audit.updatedBy,
          },
        });

        // `updateMany` con recuento cero es la señal de que el usuario no existe o es de
        // otro salón. `update` habría lanzado P2025 sin poder aplicar el filtro de tenant.
        if (result.count === 0) {
          throw new EntityNotFoundError('Usuario', user.id);
        }

        await this.prisma.client.userRole.deleteMany({ where: { userId: user.id } });
        if (user.roles.length > 0) {
          await this.prisma.client.userRole.createMany({
            data: user.roles.map((role) => ({
              userId: user.id,
              roleId: role.id,
              assignedBy: user.audit.updatedBy,
            })),
          });
        }

        return this.prisma.client.user.findFirst({
          where: { id: user.id },
          include: USER_WITH_ROLES,
        });
      });

      if (!row) throw new EntityNotFoundError('Usuario', user.id);
      return this.toDomain(row);
    });
  }

  /**
   * Escribe solo el estado del intento de acceso.
   *
   * Camino caliente del login: se tocan cuatro columnas en vez de reescribir el agregado
   * y sus roles. Además evita pisar cambios concurrentes en campos que este flujo no
   * gestiona —el login no tiene por qué saber nada del perfil del usuario.
   *
   * Va sin filtro de salón porque en el login todavía no hay tenant en el contexto.
   */
  async updateLoginState(user: User): Promise<void> {
    await QueryScopeStore.crossTenant(() =>
      withMappedErrors('Usuario', () =>
        this.prisma.client.user.updateMany({
          where: { id: user.id },
          data: {
            failedLoginAttempts: user.failedLoginAttempts,
            lockedUntil: user.lockedUntil,
            lastLoginAt: user.lastLoginAt,
            passwordHash: user.passwordHash,
            updatedAt: this.clock.now(),
          },
        }),
      ),
    );
  }

  async softDelete(id: string, actorId: string | null): Promise<void> {
    const now = this.clock.now();
    const result = await withMappedErrors('Usuario', () =>
      this.prisma.client.user.updateMany({
        where: { id },
        data: {
          deletedAt: now,
          deletedBy: actorId,
          updatedAt: now,
          updatedBy: actorId,
          // Dar de baja a alguien tiene que cortar su acceso ya, no cuando expire su
          // token: sin esto seguiría trabajando hasta 15 minutos después.
          tokenVersion: { increment: 1 },
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError('Usuario', id);
    }
  }

  async restore(id: string, actorId: string | null): Promise<User> {
    const now = this.clock.now();

    return QueryScopeStore.includingDeleted(async () => {
      const result = await withMappedErrors('Usuario', () =>
        this.prisma.client.user.updateMany({
          where: { id, deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, updatedAt: now, updatedBy: actorId },
        }),
      );

      if (result.count === 0) {
        throw new EntityNotFoundError('Usuario eliminado', id);
      }

      const restored = await this.findById(id);
      if (!restored) throw new EntityNotFoundError('Usuario', id);
      return restored;
    });
  }

  // -- Mapeo ----------------------------------------------------------------

  private buildWhere(filter: UserFilter): Prisma.UserWhereInput {
    const conditions: Prisma.UserWhereInput[] = [];

    if (filter.status) conditions.push({ status: filter.status });
    if (filter.roleCode) conditions.push({ roles: { some: { role: { code: filter.roleCode } } } });
    if (filter.search?.trim()) {
      const term = filter.search.trim();
      conditions.push({
        OR: [
          { email: { contains: term, mode: 'insensitive' } },
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    return conditions.length > 0 ? { AND: conditions } : {};
  }

  private toPersistence(user: User) {
    return {
      email: user.email.value,
      passwordHash: user.passwordHash,
      firstName: user.name.firstName,
      lastName: user.name.lastName,
      phone: user.phone?.value ?? null,
      avatarUrl: user.avatarUrl,
      status: user.status,
      locale: user.locale,
      emailVerifiedAt: user.emailVerifiedAt,
      lastLoginAt: user.lastLoginAt,
      tokenVersion: user.tokenVersion,
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
    };
  }

  /**
   * Frontera entre persistencia y dominio.
   *
   * Aquí es donde las cadenas sueltas de la base se convierten en value objects
   * validados. A partir de este punto ningún tipo de Prisma circula por el sistema
   * (ADR-0001), y el dominio tiene la garantía de que un `Email` es un correo de verdad.
   */
  private toDomain(row: UserRow): User {
    const roles: AssignedRole[] = row.roles.map(({ role }) => ({
      id: role.id,
      code: role.code,
      permissions: role.permissions.map((rp) => rp.permission.code),
    }));

    return User.rehydrate(row.id, {
      tenantId: row.tenantId,
      email: Email.create(row.email),
      passwordHash: row.passwordHash,
      name: PersonName.create(row.firstName, row.lastName),
      phone: Phone.createOptional(row.phone),
      avatarUrl: row.avatarUrl,
      status: row.status,
      locale: row.locale,
      emailVerifiedAt: row.emailVerifiedAt,
      lastLoginAt: row.lastLoginAt,
      tokenVersion: row.tokenVersion,
      failedLoginAttempts: row.failedLoginAttempts,
      lockedUntil: row.lockedUntil,
      roles,
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

  private scoped<T>(options: QueryOptions | undefined, work: () => Promise<T>): Promise<T> {
    return options?.includeDeleted ? QueryScopeStore.includingDeleted(work) : work();
  }
}
