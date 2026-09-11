/**
 * Puerto del almacén de refresh tokens (ADR-0005).
 *
 * El token **nunca** se guarda en claro: se persiste su hash Argon2id. Un volcado de
 * esta tabla —por una copia de seguridad mal protegida o una inyección SQL en otra
 * parte— no permitiría entonces suplantar a nadie.
 *
 * La consecuencia de diseño es importante: al no poder buscar por el valor del token,
 * la búsqueda se hace por `jti`, que sí viaja en claro dentro del JWT firmado, y el
 * hash solo sirve para **confirmar** que el portador tiene el token entero. Es la misma
 * separación que entre un nombre de usuario y su contraseña.
 */

export interface RefreshTokenRecord {
  readonly id: string;
  readonly jti: string;
  readonly userId: string;
  readonly tenantId: string | null;
  readonly tokenHash: string;
  /** Agrupa la cadena de rotaciones nacida de un mismo inicio de sesión. */
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly replacedById: string | null;
  readonly createdAt: Date;
}

export interface CreateRefreshTokenInput {
  readonly id: string;
  readonly jti: string;
  readonly userId: string;
  readonly tenantId: string | null;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export interface RefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord>;

  /** Localiza por identificador de token. Devuelve también los ya revocados: son la
   *  señal que dispara la detección de reutilización. */
  findByJti(jti: string): Promise<RefreshTokenRecord | null>;

  /** Marca como rotado y enlaza con su sucesor, dejando la cadena trazable. */
  rotate(id: string, replacedById: string, now: Date): Promise<void>;

  revoke(id: string, reason: string, now: Date): Promise<void>;

  /**
   * Revoca la familia completa.
   *
   * Se invoca al detectar que un token ya rotado vuelve a presentarse. En ese momento
   * hay dos portadores del mismo token y no se puede saber cuál es el legítimo, así que
   * se cierran todas las sesiones de esa cadena y se obliga a autenticarse de nuevo.
   * Es agresivo a propósito: la alternativa es dejar viva la sesión del atacante.
   */
  revokeFamily(familyId: string, reason: string, now: Date): Promise<number>;

  /** Cierra todas las sesiones del usuario. Cambio de contraseña, baja o "cerrar en todos
   *  los dispositivos". */
  revokeAllForUser(userId: string, reason: string, now: Date): Promise<number>;

  /** Purga de tokens caducados. La ejecuta una tarea programada, no el camino de la
   *  petición. */
  deleteExpired(before: Date): Promise<number>;
}

export const REFRESH_TOKEN_REPOSITORY = Symbol('RefreshTokenRepository');
