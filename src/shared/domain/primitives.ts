/**
 * Primitivas tácticas de DDD (ADR-0001).
 *
 * Este fichero no importa NADA: ni NestJS, ni Prisma, ni el resto de la aplicación.
 * Es la comprobación más simple de que la regla de dependencia se respeta —si algún día
 * necesita un import de infraestructura, la arquitectura se ha roto en otro sitio.
 */

/** Identidad opaca de una entidad. Se tipa por marca para que un `ClientId` no sea
 *  asignable a un `StylistId` aunque ambos sean `string` en tiempo de ejecución. */
export type Branded<T, B extends string> = T & { readonly __brand: B };

/**
 * Objeto de valor: se compara por su contenido, no por identidad, y es inmutable.
 *
 * La igualdad estructural se implementa aquí una sola vez. Las subclases solo aportan
 * su validación y sus operaciones.
 */
export abstract class ValueObject<T extends Record<string, unknown>> {
  protected readonly props: Readonly<T>;

  protected constructor(props: T) {
    this.props = Object.freeze({ ...props });
  }

  public equals(other?: ValueObject<T> | null): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    return this.serialize() === other.serialize();
  }

  /** Representación canónica para comparar. Determinista: las claves van ordenadas,
   *  de modo que `{a:1,b:2}` y `{b:2,a:1}` produzcan la misma cadena. */
  private serialize(): string {
    const ordered = Object.keys(this.props)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = this.props[key];
        return acc;
      }, {});
    return JSON.stringify(ordered);
  }
}

/**
 * Entidad: se compara por identidad. Dos clientes con el mismo nombre son distintos;
 * el mismo cliente con el nombre cambiado sigue siendo el mismo.
 */
export abstract class Entity<TId extends string = string> {
  protected constructor(public readonly id: TId) {
    if (!id) {
      throw new Error(`${new.target.name} requiere un identificador`);
    }
  }

  public equals(other?: Entity<TId> | null): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    return this.id === other.id;
  }
}

/** Evento de dominio: algo relevante que ya ocurrió. Nombre siempre en pasado. */
export interface DomainEvent {
  readonly name: string;
  readonly aggregateId: string;
  readonly tenantId: string | null;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Raíz de agregado: la única puerta de entrada a un grupo de objetos que cambian juntos
 * y comparten invariantes. Se guarda y se carga entera; nadie modifica sus hijos por
 * fuera.
 *
 * Los eventos se acumulan en el agregado y los publica la capa de aplicación **después**
 * de que la transacción confirme. Emitirlos durante la transacción produciría efectos
 * (correos, notificaciones) para cambios que luego se deshacen.
 */
export abstract class AggregateRoot<TId extends string = string> extends Entity<TId> {
  private domainEvents: DomainEvent[] = [];

  protected addEvent(event: DomainEvent): void {
    this.domainEvents.push(event);
  }

  public pullEvents(): DomainEvent[] {
    const events = this.domainEvents;
    this.domainEvents = [];
    return events;
  }

  public get hasUncommittedEvents(): boolean {
    return this.domainEvents.length > 0;
  }
}

/** Metadatos de auditoría comunes a toda entidad persistida (ADR-0004). */
export interface AuditMetadata {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly deletedBy: string | null;
}

export const emptyAuditMetadata = (now: Date, actorId: string | null = null): AuditMetadata => ({
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  createdBy: actorId,
  updatedBy: actorId,
  deletedBy: null,
});
