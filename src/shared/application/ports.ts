/**
 * Puertos de la capa de aplicación.
 *
 * Todo lo que la aplicación necesita del mundo exterior —hora, identificadores,
 * criptografía, auditoría— entra por aquí. El motivo no es purismo: es que el reloj y
 * el generador de UUID son las dos fuentes de indeterminismo que hacen que un test
 * falle los martes, y detrás de un puerto se sustituyen por valores fijos.
 *
 * Cada puerto lleva su token de inyección: NestJS no puede inyectar por interfaz,
 * porque las interfaces de TypeScript no existen en tiempo de ejecución.
 */

// ---------------------------------------------------------------------------
// Reloj
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/**
 * Genera UUIDv7: ordenados en el tiempo, lo que evita la fragmentación de índice de
 * UUIDv4 al insertar en posiciones aleatorias del B-tree. El identificador lo genera
 * la **aplicación**, no la base de datos: así el agregado tiene identidad antes de
 * persistirse y puede emitir eventos que la referencian.
 */
export interface IdGenerator {
  generate(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');

// ---------------------------------------------------------------------------
// Contraseñas
// ---------------------------------------------------------------------------

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  /**
   * Consume el mismo tiempo que una verificación real contra un hash señuelo.
   *
   * Se invoca cuando el correo no existe. Sin esto, el login responde antes para los
   * correos desconocidos que para los conocidos, y esa diferencia de milisegundos
   * permite enumerar la base de usuarios (ADR-0005).
   */
  verifyDummy(): Promise<void>;
  /** `true` si el hash se creó con parámetros más débiles que los actuales. */
  needsRehash(hash: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PasswordHasher');

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface AccessTokenClaims {
  readonly sub: string;
  readonly tenantId: string | null;
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  /** Versión de token del usuario; permite revocar en bloque (ADR-0005). */
  readonly tv: number;
  readonly jti: string;
}

export interface RefreshTokenClaims {
  readonly sub: string;
  readonly tenantId: string | null;
  readonly familyId: string;
  readonly jti: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly familyId: string;
  readonly refreshJti: string;
}

export interface TokenSigner {
  signAccess(
    claims: Omit<AccessTokenClaims, 'jti'>,
  ): Promise<{ token: string; expiresAt: Date; jti: string }>;
  signRefresh(
    claims: Omit<RefreshTokenClaims, 'jti'>,
  ): Promise<{ token: string; expiresAt: Date; jti: string }>;
  verifyAccess(token: string): Promise<AccessTokenClaims>;
  verifyRefresh(token: string): Promise<RefreshTokenClaims>;
}

export const TOKEN_SIGNER = Symbol('TokenSigner');

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

export type AuditActionName =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'RESTORE'
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'TOKEN_REFRESH'
  | 'TOKEN_REUSE_DETECTED'
  | 'PERMISSION_DENIED'
  | 'EXPORT'
  | 'ANONYMIZE';

export interface AuditEntry {
  readonly action: AuditActionName;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

export const AUDIT_RECORDER = Symbol('AuditRecorder');

// ---------------------------------------------------------------------------
// Envío de correo
// ---------------------------------------------------------------------------

/**
 * Mensaje saliente. No lleva remitente: quién firma el correo es una decisión del
 * despliegue, no del caso de uso que lo origina.
 */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  /** Cuerpo en texto plano. Basta para lo que la plataforma envía hoy. */
  readonly body: string;
}

/**
 * Puerto de envío de correo.
 *
 * Existe por la recuperación de contraseña, que sin él no es utilizable en producción: el
 * token se emite correctamente y no llega a su destinatario.
 *
 * El contrato es deliberadamente pobre —sin plantillas, sin adjuntos, sin HTML— porque
 * ampliarlo antes de tener un segundo caso de uso sería inventar requisitos. `send` no
 * promete entrega, solo aceptación: un correo puede rebotar horas después y eso no es algo
 * que un caso de uso pueda ni deba esperar.
 */
export interface EmailSender {
  send(email: OutboundEmail): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EmailSender');

// ---------------------------------------------------------------------------
// Caso de uso
// ---------------------------------------------------------------------------

/**
 * Un caso de uso: una intención del negocio, una transacción, un punto de entrada.
 *
 * La firma de un solo método es intencionada. Un objeto con `create`, `update`,
 * `findAll` y `remove` es un *service*, y un *service* con siete dependencias inyectadas
 * es donde vuelve a acumularse la lógica que esta arquitectura reparte.
 */
export interface UseCase<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}
