import { DomainValidationError } from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { WILDCARD_PERMISSION } from '../../../shared/domain/authorization';
import {
  AccountLockedError,
  AccountNotActiveError,
  SamePasswordError,
  WeakPasswordError,
} from './user.errors';

/**
 * Usuario del sistema: la raíz de agregado de la identidad.
 *
 * Concentra aquí, y no en el caso de uso, todo lo que decide si alguien puede entrar:
 * estado de la cuenta, bloqueo por intentos fallidos y versión de token. El motivo es
 * que esas reglas se consultan desde el login, desde el refresco y desde el cambio de
 * contraseña; repetidas en tres sitios acabarían divergiendo, y la que se quedara atrás
 * sería un agujero.
 *
 * La entidad **nunca** ve contraseñas en claro: recibe hashes ya calculados. Comparar o
 * hashear es responsabilidad del puerto `PasswordHasher`, porque implica E/S y
 * parámetros de configuración que no pertenecen al dominio.
 */

export type UserStatusValue = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';

/** Rol tal como lo necesita la identidad: código y permisos, sin más. */
export interface AssignedRole {
  readonly id: string;
  readonly code: string;
  readonly permissions: readonly string[];
}

export interface UserProps {
  readonly tenantId: string | null;
  readonly email: Email;
  readonly passwordHash: string;
  readonly name: PersonName;
  readonly phone: Phone | null;
  readonly avatarUrl: string | null;
  readonly status: UserStatusValue;
  readonly locale: string;
  readonly emailVerifiedAt: Date | null;
  readonly lastLoginAt: Date | null;
  readonly tokenVersion: number;
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
  readonly roles: readonly AssignedRole[];
  readonly audit: AuditMetadata;
}

/** Política de contraseñas. Se aplica en el dominio para que también rija en seeds y CLI. */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireUppercase: boolean;
  readonly requireLowercase: boolean;
  readonly requireDigit: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  // 12 y no 8: con Argon2 el coste de una contraseña larga es el mismo para el usuario y
  // multiplica el del atacante. No se exige carácter especial —empuja a la gente a
  // "Password1!" y a apuntarla en un papel, que es peor que una frase larga sin símbolos.
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
};

export class User extends AggregateRoot {
  private constructor(
    id: string,
    private props: UserProps,
  ) {
    super(id);
  }

  // -- Construcción --------------------------------------------------------

  static create(params: {
    id: string;
    tenantId: string | null;
    email: Email;
    passwordHash: string;
    name: PersonName;
    phone?: Phone | null;
    locale?: string;
    roles?: readonly AssignedRole[];
    status?: UserStatusValue;
    now: Date;
    actorId: string | null;
  }): User {
    return new User(params.id, {
      tenantId: params.tenantId,
      email: params.email,
      passwordHash: params.passwordHash,
      name: params.name,
      phone: params.phone ?? null,
      avatarUrl: null,
      status: params.status ?? 'ACTIVE',
      locale: params.locale ?? 'es-GT',
      emailVerifiedAt: null,
      lastLoginAt: null,
      tokenVersion: 0,
      failedLoginAttempts: 0,
      lockedUntil: null,
      roles: params.roles ?? [],
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

  /** Reconstruye desde persistencia sin pasar por las validaciones de alta. */
  static rehydrate(id: string, props: UserProps): User {
    return new User(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string | null {
    return this.props.tenantId;
  }
  get email(): Email {
    return this.props.email;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get name(): PersonName {
    return this.props.name;
  }
  get phone(): Phone | null {
    return this.props.phone;
  }
  get avatarUrl(): string | null {
    return this.props.avatarUrl;
  }
  get status(): UserStatusValue {
    return this.props.status;
  }
  get locale(): string {
    return this.props.locale;
  }
  get tokenVersion(): number {
    return this.props.tokenVersion;
  }
  get failedLoginAttempts(): number {
    return this.props.failedLoginAttempts;
  }
  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }
  get lastLoginAt(): Date | null {
    return this.props.lastLoginAt;
  }
  get emailVerifiedAt(): Date | null {
    return this.props.emailVerifiedAt;
  }
  get roles(): readonly AssignedRole[] {
    return this.props.roles;
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

  get roleCodes(): string[] {
    return this.props.roles.map((role) => role.code);
  }

  /**
   * Permisos efectivos: la **unión** de los de todos sus roles (ADR-0006).
   *
   * Unión y no intersección: sumar roles siempre concede, nunca quita. La alternativa
   * haría que dar un rol adicional a alguien pudiera reducirle el acceso, que es
   * exactamente lo contrario de lo que espera quien administra el salón.
   */
  get effectivePermissions(): string[] {
    const merged = new Set<string>();
    for (const role of this.props.roles) {
      for (const permission of role.permissions) merged.add(permission);
    }
    return [...merged].sort();
  }

  hasPermission(permission: string): boolean {
    const granted = new Set(this.effectivePermissions);
    return granted.has(WILDCARD_PERMISSION) || granted.has(permission);
  }

  // -- Reglas de autenticación ---------------------------------------------

  isActive(): boolean {
    return this.props.status === 'ACTIVE' && !this.isDeleted;
  }

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && this.props.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Comprueba que la cuenta admite autenticación, **antes** de mirar la contraseña.
   *
   * El orden importa: verificar primero el bloqueo evita gastar el coste de Argon2 en
   * una cuenta que de todos modos no va a entrar, lo que convertiría el propio bloqueo
   * en un vector de agotamiento de CPU.
   */
  assertCanAuthenticate(now: Date): void {
    if (this.isLocked(now)) {
      throw new AccountLockedError(this.props.lockedUntil!, now);
    }
    if (!this.isActive()) {
      throw new AccountNotActiveError(this.props.status);
    }
  }

  /**
   * Registra un intento fallido y bloquea la cuenta si se supera el umbral.
   *
   * El bloqueo temporal, y no permanente, es deliberado: uno permanente convierte el
   * formulario de acceso en una herramienta de denegación de servicio —basta con fallar
   * cinco veces contra el correo de la propietaria para dejarla fuera de su propio
   * negocio hasta que alguien la desbloquee a mano.
   */
  registerFailedLogin(now: Date, maxAttempts: number, lockMinutes: number): void {
    const attempts = this.props.failedLoginAttempts + 1;
    const shouldLock = attempts >= maxAttempts;

    this.props = {
      ...this.props,
      failedLoginAttempts: attempts,
      lockedUntil: shouldLock
        ? new Date(now.getTime() + lockMinutes * 60_000)
        : this.props.lockedUntil,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  /** Un acceso correcto limpia el contador: los fallos previos ya no cuentan. */
  registerSuccessfulLogin(now: Date): void {
    this.props = {
      ...this.props,
      lastLoginAt: now,
      failedLoginAttempts: 0,
      lockedUntil: null,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  /**
   * Cambia la contraseña e invalida todas las sesiones abiertas.
   *
   * Incrementar `tokenVersion` es la parte importante: si alguien cambia su contraseña
   * es, muchas veces, porque sospecha que se la han comprometido. Dejar vivas las
   * sesiones existentes haría inútil el cambio justo cuando más falta hace.
   */
  changePassword(newHash: string, now: Date, actorId: string | null): void {
    if (newHash === this.props.passwordHash) {
      throw new SamePasswordError();
    }

    this.props = {
      ...this.props,
      passwordHash: newHash,
      tokenVersion: this.props.tokenVersion + 1,
      failedLoginAttempts: 0,
      lockedUntil: null,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Rehash silencioso tras un acceso correcto, al endurecer los parámetros de Argon2. */
  upgradePasswordHash(newHash: string, now: Date): void {
    // No toca `tokenVersion`: la contraseña es la misma, solo cambia cómo se almacena.
    // Cerrar la sesión aquí castigaría al usuario por una mejora interna del sistema.
    this.props = {
      ...this.props,
      passwordHash: newHash,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  // -- Ciclo de vida --------------------------------------------------------

  updateProfile(
    changes: {
      name?: PersonName;
      phone?: Phone | null;
      locale?: string;
      avatarUrl?: string | null;
    },
    now: Date,
    actorId: string | null,
  ): void {
    this.props = {
      ...this.props,
      name: changes.name ?? this.props.name,
      phone: changes.phone !== undefined ? changes.phone : this.props.phone,
      locale: changes.locale ?? this.props.locale,
      avatarUrl: changes.avatarUrl !== undefined ? changes.avatarUrl : this.props.avatarUrl,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  changeEmail(email: Email, now: Date, actorId: string | null): void {
    if (email.equals(this.props.email)) return;

    this.props = {
      ...this.props,
      email,
      // El correo nuevo está sin verificar y las sesiones se cierran: el correo es el
      // identificador de acceso, y cambiarlo es equivalente a cambiar de credencial.
      emailVerifiedAt: null,
      tokenVersion: this.props.tokenVersion + 1,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  deactivate(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      status: 'INACTIVE',
      // Sin esto, quien acaba de ser desactivado seguiría trabajando hasta que caducara
      // su access token, y podría refrescarlo indefinidamente.
      tokenVersion: this.props.tokenVersion + 1,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  activate(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      status: 'ACTIVE',
      failedLoginAttempts: 0,
      lockedUntil: null,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  markEmailVerified(now: Date): void {
    this.props = {
      ...this.props,
      emailVerifiedAt: now,
      status: this.props.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : this.props.status,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  /** Reasigna los roles por completo. Invalida las sesiones para que el JWT se rehaga. */
  assignRoles(roles: readonly AssignedRole[], now: Date, actorId: string | null): void {
    if (roles.length === 0) {
      throw new DomainValidationError('Un usuario debe tener al menos un rol', 'roles');
    }

    this.props = {
      ...this.props,
      roles: [...roles],
      // Los permisos viajan dentro del access token (ADR-0006). Sin subir la versión, un
      // cambio de rol tardaría hasta 15 minutos en notarse; peor aún, retirar permisos
      // no tendría efecto inmediato, que es justo cuando la urgencia es real.
      tokenVersion: this.props.tokenVersion + 1,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Cierra todas las sesiones activas sin tocar nada más. */
  revokeAllSessions(now: Date): void {
    this.props = {
      ...this.props,
      tokenVersion: this.props.tokenVersion + 1,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  // -- Política de contraseñas ---------------------------------------------

  /**
   * Valida una contraseña en claro contra la política.
   *
   * Es `static` porque se aplica **antes** de que exista el usuario, en el alta. Vive en
   * el dominio y no en un DTO para que rija igual desde HTTP, desde el seed y desde
   * cualquier script de administración: una política que solo se comprueba en el borde
   * es una política que se salta el primer script que alguien escriba.
   */
  static validatePasswordStrength(
    plain: string,
    policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  ): void {
    const problems: string[] = [];

    if (plain.length < policy.minLength) {
      problems.push(`Debe tener al menos ${policy.minLength} caracteres`);
    }
    if (policy.requireUppercase && !/[A-ZÁÉÍÓÚÑÜ]/.test(plain)) {
      problems.push('Debe incluir al menos una letra mayúscula');
    }
    if (policy.requireLowercase && !/[a-záéíóúñü]/.test(plain)) {
      problems.push('Debe incluir al menos una letra minúscula');
    }
    if (policy.requireDigit && !/\d/.test(plain)) {
      problems.push('Debe incluir al menos un número');
    }

    if (problems.length > 0) {
      throw new WeakPasswordError(problems);
    }
  }
}
