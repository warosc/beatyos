import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Category, CategoryKindValue } from './category.entity';
import type { Service } from './service.entity';

// ---------------------------------------------------------------------------
// Servicios
// ---------------------------------------------------------------------------

export interface ServiceFilter {
  readonly search?: string;
  readonly categoryId?: string;
  readonly isActive?: boolean;
  readonly bookableOnline?: boolean;
  readonly maxDurationMinutes?: number;
}

export type ServiceSortField =
  'name' | 'code' | 'price' | 'durationMinutes' | 'sortOrder' | 'createdAt';

export interface ServiceRepository extends SearchableRepository<
  Service,
  ServiceFilter,
  ServiceSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Service>;

  findByCode(code: string, options?: QueryOptions): Promise<Service | null>;

  /**
   * Carga varios servicios de golpe.
   *
   * La existe para la agenda: una cita con cuatro servicios necesita sus precios y
   * duraciones, y hacerlo con cuatro consultas sueltas es el problema N+1 en el camino
   * más caliente del sistema.
   *
   * Devuelve solo los encontrados; comprobar que no falta ninguno es cosa del caso de uso,
   * que es quien sabe si un servicio ausente es un error o una omisión aceptable.
   */
  findManyByIds(ids: readonly string[]): Promise<Service[]>;

  search(
    filter: ServiceFilter,
    page: PageRequest<ServiceSortField>,
    options?: QueryOptions,
  ): Promise<Page<Service>>;

  create(service: Service): Promise<Service>;
  update(service: Service): Promise<Service>;
}

export const SERVICE_REPOSITORY = Symbol('ServiceRepository');

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------

export interface CategoryFilter {
  readonly kind?: CategoryKindValue;
  readonly parentId?: string | null;
  readonly isActive?: boolean;
  readonly search?: string;
}

export type CategorySortField = 'name' | 'sortOrder' | 'createdAt';

export interface CategoryRepository extends SearchableRepository<
  Category,
  CategoryFilter,
  CategorySortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Category>;

  /**
   * Cadena de ascendientes, de la raíz hacia abajo.
   *
   * La necesita `Category.moveTo` para detectar ciclos. Se resuelve aquí y no en el
   * dominio porque exige recorrer la base de datos, y una entidad que consulta el
   * repositorio deja de ser una entidad (ADR-0001).
   */
  findAncestorIds(categoryId: string): Promise<string[]>;

  /** `true` si cuelga algo de la categoría: subcategorías, servicios o productos. */
  hasChildren(categoryId: string): Promise<boolean>;

  /** Árbol completo de un tipo. Alimenta el menú del catálogo de una sola consulta. */
  findTree(kind: CategoryKindValue): Promise<Category[]>;

  create(category: Category): Promise<Category>;
  update(category: Category): Promise<Category>;
}

export const CATEGORY_REPOSITORY = Symbol('CategoryRepository');
