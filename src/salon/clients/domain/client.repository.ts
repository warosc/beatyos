import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Client, ClientStatusValue } from './client.entity';

/**
 * Puerto de persistencia de clientas.
 *
 * `SearchableRepository` aporta ya `findById`, `save`, `softDelete`, `restore`, `search`
 * y `count`. Aquí solo se declara lo **propio del recurso**: cada método añadido debe
 * justificar por qué no puede expresarse con `search` y un filtro.
 */

export interface ClientFilter {
  /** Búsqueda libre por nombre, correo o teléfono: es como busca la recepción. */
  readonly search?: string;
  readonly status?: ClientStatusValue;
  readonly marketingConsent?: boolean;
  readonly city?: string;
  /** Sin visitas desde esta fecha. Alimenta las campañas de recuperación. */
  readonly inactiveSince?: Date;
  readonly birthdayWithinDays?: number;
}

export type ClientSortField =
  'name' | 'createdAt' | 'lastVisitAt' | 'totalSpent' | 'totalVisits' | 'loyaltyPoints';

export interface ClientRepository extends SearchableRepository<
  Client,
  ClientFilter,
  ClientSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Client>;

  /**
   * Localiza por correo dentro del salón activo.
   *
   * Se usa para avisar de duplicados en el alta. Devuelve también un resultado si la
   * ficha está dada de baja: el mensaje útil es "ya existe una ficha eliminada con ese
   * correo, ¿desea recuperarla?" y no un error de unicidad opaco contra una fila que la
   * recepcionista no puede ver.
   */
  findByEmail(email: string, options?: QueryOptions): Promise<Client | null>;

  findByPhone(phone: string): Promise<Client | null>;

  search(
    filter: ClientFilter,
    page: PageRequest<ClientSortField>,
    options?: QueryOptions,
  ): Promise<Page<Client>>;

  create(client: Client): Promise<Client>;
  update(client: Client): Promise<Client>;
}

export const CLIENT_REPOSITORY = Symbol('ClientRepository');
