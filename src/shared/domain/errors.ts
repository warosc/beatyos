/**
 * Errores de dominio (ADR-0008).
 *
 * El dominio no conoce HTTP. Lanza estos tipos con un `code` estable; el filtro global
 * los traduce a estado HTTP en el borde. Esto permite reutilizar exactamente el mismo
 * dominio desde un worker, un CLI o una cola sin arrastrar el transporte.
 *
 * `code` es contrato público: los clientes ramifican sobre él. Cambiarlo es un cambio
 * incompatible; cambiar `message` no lo es.
 */

export abstract class DomainError extends Error {
  /** Código estable en SCREAMING_SNAKE_CASE. Forma parte de la API pública. */
  public abstract readonly code: string;

  /** Datos estructurados para que el cliente reaccione sin parsear el mensaje. */
  public readonly details?: Readonly<Record<string, unknown>>;

  protected constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * No existe, o existe pero fuera del alcance del solicitante.
 *
 * Es deliberado que "no existe" y "es de otro salón" produzcan el mismo error: un 403
 * confirmaría al atacante que el recurso existe, y eso ya es una fuga de información
 * entre inquilinos (ADR-0003).
 */
export class EntityNotFoundError extends DomainError {
  public readonly code = 'ENTITY_NOT_FOUND';

  constructor(entity: string, identifier: string | Record<string, unknown>) {
    const asText = typeof identifier === 'string' ? identifier : JSON.stringify(identifier);
    super(`No se encontró ${entity} (${asText})`, { entity, identifier });
  }
}

/** Choca con algo que ya existe: unicidad, solapamiento, doble emisión. */
export class ConflictError extends DomainError {
  public readonly code: string;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/** Una regla de negocio impide la operación, aunque los datos sean formalmente válidos. */
export class BusinessRuleViolationError extends DomainError {
  public readonly code: string;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/**
 * Datos malformados detectados por el dominio.
 *
 * Distinto de la validación de `class-validator` en el borde HTTP: aquélla comprueba la
 * forma del DTO; ésta comprueba invariantes del negocio y protege al dominio también
 * cuando lo invoca un seed, un test o un worker sin pasar por HTTP.
 */
export class DomainValidationError extends DomainError {
  public readonly code = 'DOMAIN_VALIDATION_ERROR';

  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message, field ? { field } : undefined);
  }
}

/**
 * Fallo de **autenticación**: no se ha podido establecer quién hace la petición.
 *
 * Distinta de `ForbiddenActionError`, que es de **autorización**: allí se sabe quién es
 * y no puede; aquí no se sabe quién es. La diferencia se traduce en 401 frente a 403, y
 * al cliente le dice cosas muy distintas —el 401 significa "vuelve a autenticarte" y el
 * 403, "no insistas con esta sesión".
 *
 * Existe como clase base para que el filtro global mapee la familia entera de una vez
 * (credenciales incorrectas, sesión caducada, token reutilizado) sin que `shared` tenga
 * que conocer los errores concretos de los módulos, lo que invertiría la dependencia.
 */
export abstract class AuthenticationError extends DomainError {}

/** El actor está autenticado pero no puede hacer esto sobre este recurso concreto. */
export class ForbiddenActionError extends DomainError {
  public readonly code = 'FORBIDDEN_ACTION';

  constructor(action: string, reason?: string) {
    super(reason ?? `No tiene permiso para: ${action}`, { action });
  }
}

/** La operación no es válida en el estado actual del agregado (máquina de estados). */
export class InvalidStateTransitionError extends DomainError {
  public readonly code = 'INVALID_STATE_TRANSITION';

  constructor(entity: string, from: string, to: string) {
    super(`${entity} no puede pasar de ${from} a ${to}`, { entity, from, to });
  }
}
