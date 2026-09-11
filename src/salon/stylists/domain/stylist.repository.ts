import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Stylist, StylistStatusValue } from './stylist.entity';

export interface StylistFilter {
  readonly search?: string;
  readonly status?: StylistStatusValue;
  /** Solo quienes saben hacer este servicio. Filtra la lista de la pantalla de reserva. */
  readonly canPerformServiceId?: string;
  readonly onlyBookable?: boolean;
}

export type StylistSortField = 'name' | 'createdAt' | 'hiredAt' | 'status';

export interface StylistRepository extends SearchableRepository<
  Stylist,
  StylistFilter,
  StylistSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Stylist>;

  /**
   * Localiza al profesional asociado a una cuenta de usuario.
   *
   * Es la consulta que sostiene el ámbito `.own` de la agenda (ADR-0006): para saber qué
   * citas son «las suyas» hay que traducir el usuario autenticado a su ficha profesional.
   * Devuelve `null` si esa cuenta no tiene ficha, que es el caso de recepción y dirección.
   */
  findByUserId(userId: string): Promise<Stylist | null>;

  search(
    filter: StylistFilter,
    page: PageRequest<StylistSortField>,
    options?: QueryOptions,
  ): Promise<Page<Stylist>>;

  create(stylist: Stylist): Promise<Stylist>;

  /** Guarda el agregado completo: ficha, horario, ausencias y habilidades. */
  update(stylist: Stylist): Promise<Stylist>;
}

export const STYLIST_REPOSITORY = Symbol('StylistRepository');
