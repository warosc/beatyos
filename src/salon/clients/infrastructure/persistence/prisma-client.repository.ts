import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client as ClientRow } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { Email, PersonName, Phone } from '../../../../shared/domain/value-objects/contact.vo';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import { Client } from '../../domain/client.entity';
import type {
  ClientFilter,
  ClientRepository,
  ClientSortField,
} from '../../domain/client.repository';

/**
 * Adaptador Prisma de clientas.
 *
 * **Esta clase es la prueba de que el shared kernel cumple su función.** Todo lo genérico
 * —paginación, ordenación validada, soft delete, restauración, ámbito de salón,
 * traducción de errores— lo hereda de `PrismaRepositoryBase`. Aquí solo queda lo que de
 * verdad es propio de las clientas: el mapeo entre fila y agregado, y la traducción de
 * su filtro tipado a un `where`.
 *
 * Sin la clase base, cada uno de los quince repositorios repetiría el mismo `skip`/`take`
 * y el mismo `deletedAt: null`, y bastaría con que uno se desviara para tener un fallo
 * imposible de localizar.
 */
@Injectable()
export class PrismaClientRepository
  extends PrismaRepositoryBase<Client, ClientRow, ClientFilter, ClientSortField>
  implements ClientRepository
{
  /**
   * Moneda con la que se reconstruye `totalSpent`.
   *
   * **Simplificación consciente.** La moneda real es la del salón (`Tenant.currency`),
   * pero leerla exigiría un `JOIN` en cada lectura de ficha para un dato que hoy es el
   * mismo para todos los inquilinos. Se toma la moneda configurada por defecto.
   *
   * Deja de valer en cuanto la plataforma opere en varias monedas a la vez. La salida no
   * es el `JOIN`, sino materializar `currency` en la fila de la clienta, como ya hacen
   * `Invoice` y `Payment`. Queda anotado aquí para que la decisión sea visible y no se
   * descubra como un error de redondeo en un informe.
   */
  private readonly currency: string;

  constructor(
    prisma: PrismaService,
    @Inject(CLOCK) clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    super(prisma, clock);
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  protected readonly delegateName = 'client';
  protected readonly entityName = 'Clienta';

  /**
   * Lista blanca de ordenación (ADR-0007).
   *
   * Ordenar por "nombre" son en realidad dos columnas, apellidos primero, como en
   * cualquier listado de personas. El mapa permite expresarlo sin que el cliente de la
   * API tenga que saberlo.
   */
  protected readonly sortableFields: ReadonlyMap<ClientSortField, OrderByClause | OrderByClause[]> =
    new Map<ClientSortField, OrderByClause | OrderByClause[]>([
      ['name', [{ lastName: true }, { firstName: true }]],
      ['createdAt', { createdAt: true }],
      ['lastVisitAt', { lastVisitAt: true }],
      ['totalSpent', { totalSpent: true }],
      ['totalVisits', { totalVisits: true }],
      ['loyaltyPoints', { loyaltyPoints: true }],
    ]);

  protected readonly defaultSort = [{ field: 'name' as const, direction: 'asc' as const }];

  // -- Consultas propias del recurso ---------------------------------------

  async findByEmail(email: string, options?: { includeDeleted?: boolean }): Promise<Client | null> {
    const find = async (): Promise<ClientRow | null> =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.client.findFirst({
          // `mode: insensitive` acompaña al índice único parcial sobre `lower(email)`.
          where: { email: { equals: email.trim().toLowerCase(), mode: 'insensitive' } },
        }),
      );

    const row = options?.includeDeleted
      ? await QueryScopeStore.includingDeleted(find)
      : await find();
    return row ? this.toDomain(row) : null;
  }

  async findByPhone(phone: string): Promise<Client | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.client.findFirst({ where: { phone: phone.replace(/[\s\-().]/g, '') } }),
    );
    return row ? this.toDomain(row) : null;
  }

  async create(client: Client): Promise<Client> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.client.create({
        data: {
          id: client.id,
          tenantId: client.tenantId,
          ...this.toPersistence(client),
          createdAt: client.audit.createdAt,
          updatedAt: client.audit.updatedAt,
          createdBy: client.audit.createdBy,
          updatedBy: client.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  /**
   * Actualiza dentro del ámbito del salón.
   *
   * `updateMany` y no `update` por el mismo motivo que en el borrado lógico: `update`
   * exige clave única en el `where` y no admitiría el `tenantId` que inyecta la
   * extensión, con lo que se podría modificar la ficha de otro inquilino conociendo su
   * identificador.
   */
  async update(client: Client): Promise<Client> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.client.updateMany({
        where: { id: client.id },
        data: {
          ...this.toPersistence(client),
          updatedAt: client.audit.updatedAt,
          updatedBy: client.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      // Se delega en el buscador de la clase base, que lanza `EntityNotFoundError`.
      return this.findByIdOrFail(client.id);
    }

    return this.findByIdOrFail(client.id, { includeDeleted: client.isDeleted });
  }

  async save(client: Client): Promise<Client> {
    return this.update(client);
  }

  // -- Filtro ---------------------------------------------------------------

  protected buildWhere(filter: ClientFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['firstName', 'lastName', 'email', 'phone']),
      filter.status ? { status: filter.status } : undefined,
      filter.marketingConsent !== undefined
        ? { marketingConsent: filter.marketingConsent }
        : undefined,
      filter.city ? { city: { equals: filter.city, mode: 'insensitive' } } : undefined,
      // "Sin visitas desde" incluye a quien nunca ha venido: es precisamente el grupo
      // que más interesa a una campaña de recuperación, y excluirlo sería un error
      // silencioso del que nadie se daría cuenta.
      filter.inactiveSince
        ? { OR: [{ lastVisitAt: { lt: filter.inactiveSince } }, { lastVisitAt: null }] }
        : undefined,
    );
  }

  // -- Mapeo ----------------------------------------------------------------

  /**
   * Columnas escribibles del agregado.
   *
   * Sin anotacion de tipo a proposito: el objeto se usa tanto en `create` como en
   * `updateMany`, y los tipos de Prisma para esas dos operaciones son incompatibles entre
   * si —el de actualizacion admite operadores como `{ increment: 1 }` que el de creacion
   * rechaza—. Dejar que TypeScript infiera los tipos concretos hace que el objeto encaje
   * en ambas sin duplicar el mapeo ni recurrir a una conversion.
   */
  private toPersistence(client: Client) {
    return {
      firstName: client.name.firstName,
      lastName: client.name.lastName,
      email: client.email?.value ?? null,
      phone: client.phone?.value ?? null,
      birthDate: client.birthDate,
      gender: client.gender,
      notes: client.notes,
      allergies: client.allergies,
      addressLine: client.addressLine,
      city: client.city,
      postalCode: client.postalCode,
      status: client.status,
      marketingConsent: client.marketingConsent,
      marketingConsentAt: client.marketingConsentAt,
      loyaltyPoints: client.loyaltyPoints,
      totalVisits: client.totalVisits,
      // Prisma acepta la cadena decimal y PostgreSQL la guarda como `numeric` exacto.
      // Pasar `Number` aquí sería reintroducir la coma flotante que `Money` existe para
      // evitar (ADR-0010).
      totalSpent: client.totalSpent.toDecimalString(),
      deletedAt: client.audit.deletedAt,
      deletedBy: client.audit.deletedBy,
    };
  }

  protected toDomain(row: ClientRow): Client {
    return Client.rehydrate(row.id, {
      tenantId: row.tenantId,
      name: PersonName.create(row.firstName, row.lastName),
      email: Email.createOptional(row.email),
      phone: Phone.createOptional(row.phone),
      birthDate: row.birthDate,
      gender: row.gender,
      notes: row.notes,
      allergies: row.allergies,
      addressLine: row.addressLine,
      city: row.city,
      postalCode: row.postalCode,
      status: row.status,
      marketingConsent: row.marketingConsent,
      marketingConsentAt: row.marketingConsentAt,
      loyaltyPoints: row.loyaltyPoints,
      totalVisits: row.totalVisits,
      // `Decimal` de Prisma se convierte aquí, en la frontera. A partir de este punto el
      // dominio solo ve `Money` y ningún tipo del ORM circula por dentro (ADR-0001).
      totalSpent: Money.fromDecimal(row.totalSpent.toFixed(2), this.currency),
      lastVisitAt: row.lastVisitAt,
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
