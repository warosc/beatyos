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
import { ConflictError } from '../../../shared/domain/errors';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { Client, type GenderValue } from '../domain/client.entity';
import {
  CLIENT_REPOSITORY,
  type ClientFilter,
  type ClientRepository,
  type ClientSortField,
} from '../domain/client.repository';

/**
 * Casos de uso de clientas.
 *
 * Van agrupados porque comparten dependencias y forman el ciclo de vida de un mismo
 * agregado. La regla que sí se respeta es la de fondo: **un método público por
 * intención de negocio**, sin ningún objeto que acumule "todo lo de clientas".
 *
 * El trabajo repetitivo —paginación, ordenación, soft delete, ámbito de salón— no
 * aparece aquí: lo resuelve `PrismaRepositoryBase` una sola vez para los quince
 * repositorios del sistema (ADR-0002).
 */

export interface CreateClientInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly birthDate?: Date | null;
  readonly gender?: GenderValue | null;
  readonly notes?: string | null;
  readonly allergies?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly marketingConsent?: boolean;
  readonly currency: string;
  readonly actorId: string | null;
  readonly tenantId: string;
}

@Injectable()
export class CreateClientUseCase implements UseCase<CreateClientInput, Client> {
  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateClientInput): Promise<Client> {
    const now = this.clock.now();
    const email = Email.createOptional(input.email);

    if (email) {
      // Comprobación previa **además** del índice único de la base. No sustituye a la
      // restricción —entre esta consulta y el INSERT cabe otra petición—, pero convierte
      // el caso habitual en un mensaje que la recepcionista entiende, en lugar de un
      // error de unicidad. La base sigue siendo la garantía; esto es la explicación.
      const existing = await this.clients.findByEmail(email.value, { includeDeleted: true });
      if (existing) {
        throw new ConflictError(
          existing.isDeleted ? 'CLIENT_EXISTS_DELETED' : 'CLIENT_EMAIL_ALREADY_EXISTS',
          existing.isDeleted
            ? 'Existe una ficha eliminada con ese correo. Recupérela en lugar de crear una nueva.'
            : 'Ya existe una clienta con ese correo electrónico',
          { clientId: existing.id, deleted: existing.isDeleted },
        );
      }
    }

    const client = Client.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      name: PersonName.create(input.firstName, input.lastName),
      email,
      phone: Phone.createOptional(input.phone),
      birthDate: input.birthDate ?? null,
      gender: input.gender ?? null,
      notes: input.notes ?? null,
      allergies: input.allergies ?? null,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      marketingConsent: input.marketingConsent ?? false,
      currency: input.currency,
      now,
      actorId: input.actorId,
    });

    const saved = await this.clients.create(client);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Client',
      entityId: saved.id,
      after: { name: saved.name.full, email: saved.email?.masked() ?? null },
    });

    return saved;
  }
}

export interface UpdateClientInput {
  readonly id: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly birthDate?: Date | null;
  readonly gender?: GenderValue | null;
  readonly notes?: string | null;
  readonly allergies?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly marketingConsent?: boolean;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateClientUseCase implements UseCase<UpdateClientInput, Client> {
  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: UpdateClientInput): Promise<Client> {
    const now = this.clock.now();

    // `findByIdOrFail` aplica el ámbito de salón: pedir la ficha de otro inquilino da un
    // 404, no un 403. Un 403 confirmaría que existe (ADR-0003).
    const client = await this.clients.findByIdOrFail(input.id);

    const before = {
      name: client.name.full,
      email: client.email?.masked() ?? null,
      marketingConsent: client.marketingConsent,
    };

    client.updateDetails(
      {
        name:
          input.firstName !== undefined || input.lastName !== undefined
            ? PersonName.create(
                input.firstName ?? client.name.firstName,
                input.lastName ?? client.name.lastName,
              )
            : undefined,
        email: input.email !== undefined ? Email.createOptional(input.email) : undefined,
        phone: input.phone !== undefined ? Phone.createOptional(input.phone) : undefined,
        birthDate: input.birthDate,
        gender: input.gender,
        notes: input.notes,
        allergies: input.allergies,
        addressLine: input.addressLine,
        city: input.city,
        postalCode: input.postalCode,
      },
      now,
      input.actorId,
    );

    if (input.marketingConsent !== undefined) {
      client.setMarketingConsent(input.marketingConsent, now, input.actorId);
    }

    const saved = await this.clients.update(client);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Client',
      entityId: saved.id,
      before,
      after: {
        name: saved.name.full,
        email: saved.email?.masked() ?? null,
        marketingConsent: saved.marketingConsent,
      },
    });

    return saved;
  }
}

@Injectable()
export class GetClientUseCase implements UseCase<string, Client> {
  constructor(@Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository) {}

  execute(id: string): Promise<Client> {
    return this.clients.findByIdOrFail(id);
  }
}

export interface SearchClientsInput {
  readonly filter: ClientFilter;
  readonly page: PageRequest<ClientSortField>;
  readonly includeDeleted?: boolean;
}

@Injectable()
export class SearchClientsUseCase implements UseCase<SearchClientsInput, Page<Client>> {
  constructor(@Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository) {}

  execute(input: SearchClientsInput): Promise<Page<Client>> {
    return this.clients.search(input.filter, input.page, {
      includeDeleted: input.includeDeleted ?? false,
    });
  }
}

export interface DeleteClientInput {
  readonly id: string;
  readonly actorId: string | null;
}

/**
 * Baja de una ficha.
 *
 * Es soft delete (ADR-0004): la ficha desaparece de los listados pero su historial —citas
 * y facturas— sigue siendo consultable y contablemente válido. Para el borrado real de
 * datos personales existe `AnonymizeClientUseCase`, que es una operación distinta, con
 * permiso distinto y consecuencias distintas.
 */
@Injectable()
export class DeleteClientUseCase implements UseCase<DeleteClientInput, void> {
  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: DeleteClientInput): Promise<void> {
    const client = await this.clients.findByIdOrFail(input.id);
    await this.clients.softDelete(input.id, input.actorId);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Client',
      entityId: input.id,
      before: { name: client.name.full },
    });
  }
}

@Injectable()
export class RestoreClientUseCase implements UseCase<DeleteClientInput, Client> {
  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: DeleteClientInput): Promise<Client> {
    const restored = await this.clients.restore(input.id, input.actorId);

    await this.audit.record({
      action: 'RESTORE',
      entityType: 'Client',
      entityId: input.id,
      after: { name: restored.name.full },
    });

    return restored;
  }
}

export interface AnonymizeClientInput {
  readonly id: string;
  readonly actorId: string | null;
  /** Motivo de la solicitud. Se registra: es la prueba de que se atendió el derecho. */
  readonly reason: string;
}

/**
 * Derecho de supresión del RGPD.
 *
 * Deliberadamente separado del borrado normal, con su propio permiso
 * (`clients.anonymize`) y **sin vuelta atrás**. Sobrescribe los datos personales y
 * conserva la fila, de modo que las facturas emitidas sigan siendo válidas: la
 * obligación fiscal de conservarlas y el derecho de supresión conviven así sin que
 * ninguno de los dos se incumpla.
 */
@Injectable()
export class AnonymizeClientUseCase implements UseCase<AnonymizeClientInput, void> {
  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: AnonymizeClientInput): Promise<void> {
    const client = await this.clients.findByIdOrFail(input.id, { includeDeleted: true });

    client.anonymize(this.clock.now(), input.actorId);
    await this.clients.update(client);

    // La entrada de auditoría NO guarda los datos anteriores: copiarlos aquí dejaría
    // exactamente lo que se acaba de suprimir en una tabla append-only que nadie puede
    // borrar. Se registra el hecho y el motivo, nunca el contenido.
    await this.audit.record({
      action: 'ANONYMIZE',
      entityType: 'Client',
      entityId: input.id,
      metadata: { reason: input.reason, irreversible: true },
    });
  }
}
