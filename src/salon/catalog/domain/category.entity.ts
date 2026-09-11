import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';

/**
 * Categoría del catálogo, común a servicios y productos.
 *
 * Una sola entidad discriminada por `kind` en vez de dos tablas gemelas: el árbol, su
 * gestión y sus reglas son idénticos, y duplicarlas garantizaría que una de las dos se
 * quedara sin la corrección que se aplicase a la otra (ADR-0002).
 */

export type CategoryKindValue = 'SERVICE' | 'PRODUCT';

export interface CategoryProps {
  readonly tenantId: string;
  readonly kind: CategoryKindValue;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly color: string | null;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly audit: AuditMetadata;
}

/** Profundidad máxima del árbol. Ver `assertCanBeChildOf`. */
export const MAX_CATEGORY_DEPTH = 3;

export class Category extends AggregateRoot {
  private constructor(
    id: string,
    private props: CategoryProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    kind: CategoryKindValue;
    name: string;
    slug?: string;
    description?: string | null;
    color?: string | null;
    parentId?: string | null;
    sortOrder?: number;
    now: Date;
    actorId: string | null;
  }): Category {
    const name = params.name?.trim();
    if (!name) {
      throw new DomainValidationError('El nombre de la categoría es obligatorio', 'name');
    }

    return new Category(params.id, {
      tenantId: params.tenantId,
      kind: params.kind,
      name,
      slug: Category.toSlug(params.slug ?? name),
      description: params.description ?? null,
      color: params.color ?? null,
      parentId: params.parentId ?? null,
      sortOrder: params.sortOrder ?? 0,
      isActive: true,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: CategoryProps): Category {
    return new Category(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get kind(): CategoryKindValue {
    return this.props.kind;
  }
  get name(): string {
    return this.props.name;
  }
  get slug(): string {
    return this.props.slug;
  }
  get description(): string | null {
    return this.props.description;
  }
  get color(): string | null {
    return this.props.color;
  }
  get parentId(): string | null {
    return this.props.parentId;
  }
  get sortOrder(): number {
    return this.props.sortOrder;
  }
  get isActive(): boolean {
    return this.props.isActive;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * Sella la baja lógica (ADR-0004).
   *
   * No borra: marca. El repositorio persiste el sello, pero la decisión pertenece al
   * dominio —es él quien sabe qué significa que algo esté dado de baja— y tenerla aquí
   * permite que los dobles en memoria de los tests reproduzcan el comportamiento real.
   */
  markDeleted(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  /** Deshace la baja lógica. */
  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }
  get isRoot(): boolean {
    return this.props.parentId === null;
  }

  // -- Comportamiento -------------------------------------------------------

  updateDetails(
    changes: {
      name?: string;
      slug?: string;
      description?: string | null;
      color?: string | null;
      sortOrder?: number;
    },
    now: Date,
    actorId: string | null,
  ): void {
    if (changes.name !== undefined && !changes.name.trim()) {
      throw new DomainValidationError('El nombre de la categoría es obligatorio', 'name');
    }

    this.props = {
      ...this.props,
      name: changes.name?.trim() ?? this.props.name,
      // El slug NO se regenera al renombrar: puede estar en una URL pública que dejaría
      // de funcionar. Cambiarlo es una decisión explícita.
      slug: changes.slug !== undefined ? Category.toSlug(changes.slug) : this.props.slug,
      description: changes.description !== undefined ? changes.description : this.props.description,
      color: changes.color !== undefined ? changes.color : this.props.color,
      sortOrder: changes.sortOrder ?? this.props.sortOrder,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Cambia la categoría de sitio dentro del árbol.
   *
   * `ancestorIds` es la cadena de ascendientes del destino, que el caso de uso resuelve
   * consultando el repositorio. Se pasa como parámetro y no se consulta desde aquí porque
   * el dominio no habla con la base de datos; a cambio, la regla —el ciclo— sí se
   * comprueba donde tiene que estar.
   */
  moveTo(
    parentId: string | null,
    ancestorIds: readonly string[],
    now: Date,
    actorId: string | null,
  ): void {
    if (parentId === this.id) {
      throw new BusinessRuleViolationError(
        'CATEGORY_SELF_PARENT',
        'Una categoría no puede ser su propia madre',
      );
    }

    // Un ciclo dejaría el árbol irrecorrible: al pintar el menú, la aplicación entraría
    // en recursión infinita. Y el ciclo se crea sin querer, arrastrando una rama sobre su
    // propia descendiente.
    if (parentId !== null && ancestorIds.includes(this.id)) {
      throw new BusinessRuleViolationError(
        'CATEGORY_CYCLE',
        'No se puede mover una categoría dentro de una de sus descendientes',
        { categoryId: this.id, targetParentId: parentId },
      );
    }

    if (parentId !== null && ancestorIds.length + 1 >= MAX_CATEGORY_DEPTH) {
      // El límite es de usabilidad, no técnico: un árbol de más de tres niveles deja de
      // ayudar a encontrar nada y convierte el menú en un laberinto.
      throw new BusinessRuleViolationError(
        'CATEGORY_TOO_DEEP',
        `El árbol de categorías no puede tener más de ${MAX_CATEGORY_DEPTH} niveles`,
      );
    }

    this.props = {
      ...this.props,
      parentId,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  setActive(isActive: boolean, now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      isActive,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** `true` si la categoría admite ese tipo de elemento. */
  accepts(kind: CategoryKindValue): boolean {
    return this.props.kind === kind;
  }

  /**
   * Normaliza un texto a identificador de URL.
   *
   * Se descomponen los acentos y se descartan las marcas diacríticas, de modo que
   * «Coloración» produzca `coloracion` y no `coloraci-n`, que es lo que sale al filtrar
   * caracteres sin descomponer primero.
   */
  static toSlug(value: string): string {
    const slug = value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!slug) {
      throw new DomainValidationError(
        `No se pudo generar un identificador a partir de "${value}"`,
        'slug',
      );
    }
    return slug;
  }
}
