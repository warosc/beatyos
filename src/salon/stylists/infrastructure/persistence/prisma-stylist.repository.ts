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
import { Percentage, TimeRange } from '../../../../shared/domain/value-objects/time-range.vo';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { Stylist } from '../../domain/stylist.entity';
import type {
  StylistFilter,
  StylistRepository,
  StylistSortField,
} from '../../domain/stylist.repository';

/**
 * Adaptador Prisma de profesionales.
 *
 * El agregado incluye tres colecciones —horario, ausencias y habilidades— que se guardan
 * en tablas aparte. La sincronización es de reemplazo completo dentro de una transacción:
 * el horario semanal tiene cinco o seis tramos, calcular la diferencia mínima no compensa,
 * y lo que sí es innegociable es la atomicidad —un horario a medias dejaría al profesional
 * sin disponibilidad y las reservas del día caerían.
 */
const STYLIST_INCLUDE = {
  schedules: true,
  timeOff: true,
  skills: true,
} satisfies Prisma.StylistInclude;

type StylistRow = Prisma.StylistGetPayload<{ include: typeof STYLIST_INCLUDE }>;

@Injectable()
export class PrismaStylistRepository
  extends PrismaRepositoryBase<Stylist, StylistRow, StylistFilter, StylistSortField>
  implements StylistRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'stylist';
  protected readonly entityName = 'Profesional';

  protected readonly sortableFields: ReadonlyMap<
    StylistSortField,
    OrderByClause | OrderByClause[]
  > = new Map<StylistSortField, OrderByClause | OrderByClause[]>([
    ['name', [{ lastName: true }, { firstName: true }]],
    ['createdAt', { createdAt: true }],
    ['hiredAt', { hiredAt: true }],
    ['status', { status: true }],
  ]);

  protected readonly defaultSort = [{ field: 'name' as const, direction: 'asc' as const }];

  // -- Lecturas -------------------------------------------------------------

  /**
   * Sobrescribe la búsqueda de la clase base para arrastrar las colecciones.
   *
   * La base devuelve la fila desnuda, y un profesional sin su horario no puede responder
   * a la pregunta que da sentido a este agregado: cuándo está disponible.
   */
  override async findById(id: string, options?: QueryOptions): Promise<Stylist | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.stylist.findFirst({ where: { id }, include: STYLIST_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByUserId(userId: string): Promise<Stylist | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.stylist.findFirst({ where: { userId }, include: STYLIST_INCLUDE }),
    );
    return row ? this.toDomain(row) : null;
  }

  override async search(
    filter: StylistFilter,
    page: PageRequest<StylistSortField>,
    options?: QueryOptions,
  ): Promise<Page<Stylist>> {
    const where = this.buildWhere(filter);
    const orderBy = this.buildOrderBy(page.sort);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.stylist.count({ where }),
          this.prisma.client.stylist.findMany({
            where,
            orderBy,
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: STYLIST_INCLUDE,
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

  // -- Escrituras -----------------------------------------------------------

  async create(stylist: Stylist): Promise<Stylist> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.stylist.create({
        data: {
          id: stylist.id,
          tenantId: stylist.tenantId,
          ...this.toPersistence(stylist),
          createdAt: stylist.audit.createdAt,
          updatedAt: stylist.audit.updatedAt,
          createdBy: stylist.audit.createdBy,
          updatedBy: stylist.audit.updatedBy,
        },
        include: STYLIST_INCLUDE,
      }),
    );
    return this.toDomain(row);
  }

  async update(stylist: Stylist): Promise<Stylist> {
    return this.prisma.transaction(async () => {
      const result = await withMappedErrors(this.entityName, () =>
        this.prisma.client.stylist.updateMany({
          where: { id: stylist.id },
          data: {
            ...this.toPersistence(stylist),
            updatedAt: stylist.audit.updatedAt,
            updatedBy: stylist.audit.updatedBy,
          },
        }),
      );

      if (result.count === 0) {
        throw new EntityNotFoundError(this.entityName, stylist.id);
      }

      await this.syncCollections(stylist);

      const row = await this.prisma.client.stylist.findFirst({
        where: { id: stylist.id },
        include: STYLIST_INCLUDE,
      });

      if (!row) throw new EntityNotFoundError(this.entityName, stylist.id);
      return this.toDomain(row);
    });
  }

  async save(stylist: Stylist): Promise<Stylist> {
    return this.update(stylist);
  }

  /**
   * Reemplaza las tres colecciones del agregado.
   *
   * El `tenantId` se pone a mano en cada fila hija: las escrituras anidadas y `createMany`
   * de Prisma **no pasan por la extensión** que lo inyecta (ver `prisma.extensions.ts`).
   * Omitirlo aquí dejaría horarios sin salón, invisibles para cualquier consulta posterior.
   */
  private async syncCollections(stylist: Stylist): Promise<void> {
    await this.prisma.client.stylistSchedule.deleteMany({ where: { stylistId: stylist.id } });
    if (stylist.schedule.length > 0) {
      await this.prisma.client.stylistSchedule.createMany({
        data: stylist.schedule.map((block) => ({
          id: block.id,
          tenantId: stylist.tenantId,
          stylistId: stylist.id,
          dayOfWeek: block.dayOfWeek,
          startMinutes: block.startMinutes,
          endMinutes: block.endMinutes,
        })),
      });
    }

    await this.prisma.client.stylistTimeOff.deleteMany({ where: { stylistId: stylist.id } });
    if (stylist.timeOff.length > 0) {
      await this.prisma.client.stylistTimeOff.createMany({
        data: stylist.timeOff.map((period) => ({
          id: period.id,
          tenantId: stylist.tenantId,
          stylistId: stylist.id,
          startsAt: period.range.startsAt,
          endsAt: period.range.endsAt,
          reason: period.reason,
        })),
      });
    }

    await this.prisma.client.stylistService.deleteMany({ where: { stylistId: stylist.id } });
    if (stylist.skills.length > 0) {
      await this.prisma.client.stylistService.createMany({
        data: stylist.skills.map((skill) => ({
          tenantId: stylist.tenantId,
          stylistId: stylist.id,
          serviceId: skill.serviceId,
          durationMinutes: skill.durationMinutes,
          commissionRate: skill.commissionRate?.value ?? null,
        })),
      });
    }
  }

  // -- Filtro ---------------------------------------------------------------

  protected buildWhere(filter: StylistFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['firstName', 'lastName', 'email', 'displayName']),
      filter.status ? { status: filter.status } : undefined,
      filter.onlyBookable ? { status: 'ACTIVE' } : undefined,
      // Sin habilidades declaradas se asume que puede hacerlo todo, así que el filtro
      // incluye también a quien no tiene ninguna. Excluirlos dejaría fuera a los salones
      // que aún no han rellenado la matriz de servicio×profesional.
      filter.canPerformServiceId
        ? {
            OR: [
              { skills: { some: { serviceId: filter.canPerformServiceId } } },
              { skills: { none: {} } },
            ],
          }
        : undefined,
    );
  }

  // -- Mapeo ----------------------------------------------------------------

  private toPersistence(stylist: Stylist) {
    return {
      userId: stylist.userId,
      firstName: stylist.name.firstName,
      lastName: stylist.name.lastName,
      email: stylist.email?.value ?? null,
      phone: stylist.phone?.value ?? null,
      displayName: stylist.displayName,
      bio: stylist.bio,
      color: stylist.color,
      status: stylist.status,
      hiredAt: stylist.hiredAt,
      commissionRate: stylist.commissionRate.value.toFixed(2),
      deletedAt: stylist.audit.deletedAt,
      deletedBy: stylist.audit.deletedBy,
    };
  }

  protected toDomain(row: StylistRow): Stylist {
    return Stylist.rehydrate(row.id, {
      tenantId: row.tenantId,
      userId: row.userId,
      name: PersonName.create(row.firstName, row.lastName),
      email: Email.createOptional(row.email),
      phone: Phone.createOptional(row.phone),
      displayName: row.displayName,
      bio: row.bio,
      color: row.color,
      status: row.status,
      hiredAt: row.hiredAt,
      commissionRate: Percentage.create(Number(row.commissionRate)),
      schedule: row.schedules.map((block) => ({
        id: block.id,
        dayOfWeek: block.dayOfWeek,
        startMinutes: block.startMinutes,
        endMinutes: block.endMinutes,
      })),
      timeOff: row.timeOff.map((period) => ({
        id: period.id,
        range: TimeRange.create(period.startsAt, period.endsAt),
        reason: period.reason,
      })),
      skills: row.skills.map((skill) => ({
        serviceId: skill.serviceId,
        durationMinutes: skill.durationMinutes,
        commissionRate:
          skill.commissionRate === null ? null : Percentage.create(Number(skill.commissionRate)),
      })),
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
