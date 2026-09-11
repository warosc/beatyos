import {
  AuthenticationError,
  BusinessRuleViolationError,
  ConflictError,
} from '../../../shared/domain/errors';

/**
 * Errores del módulo de identidad.
 *
 * El diseño de estos mensajes es una decisión de seguridad, no de redacción: lo que la
 * API cuenta a quien falla al autenticarse determina cuánto puede aprender un atacante
 * sobre las cuentas que existen.
 */

/**
 * Credenciales inválidas.
 *
 * Un único error para "ese correo no existe" y "esa contraseña no es". Distinguirlos
 * convertiría el formulario de acceso en un oráculo para enumerar la base de usuarios:
 * bastaría probar correos y quedarse con los que responden "contraseña incorrecta".
 *
 * Por el mismo motivo no lleva `details`: cualquier dato adicional reintroduciría la
 * diferencia que el mensaje común elimina.
 */
export class InvalidCredentialsError extends AuthenticationError {
  public readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Correo electrónico o contraseña incorrectos');
  }
}

/**
 * Cuenta bloqueada por intentos fallidos.
 *
 * Aquí sí se da información —cuándo se desbloquea— porque a estas alturas quien la
 * recibe ya ha demostrado conocer una cuenta existente, y la persona legítima que ha
 * fallado tres veces merece saber cuánto tiene que esperar en lugar de creer que el
 * sistema está roto.
 */
export class AccountLockedError extends BusinessRuleViolationError {
  /**
   * @param now Instante de referencia, tomado del puerto `Clock`.
   *
   * Recibirlo en lugar de llamar a `Date.now()` no es purismo: el dominio no debe
   * consultar el reloj del sistema. Cuando lo hacía, el mensaje decía "inténtelo en 1
   * minuto" en cualquier escenario con un reloj controlado —tests, reprocesos, jobs
   * diferidos—, porque comparaba una fecha del dominio con la hora real de la máquina.
   */
  constructor(lockedUntil: Date, now: Date) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    super(
      'ACCOUNT_LOCKED',
      `Cuenta bloqueada temporalmente por intentos fallidos. Inténtelo de nuevo en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
      { lockedUntil: lockedUntil.toISOString() },
    );
  }
}

export class AccountNotActiveError extends BusinessRuleViolationError {
  constructor(status: string) {
    super(
      'ACCOUNT_NOT_ACTIVE',
      'La cuenta no está activa. Contacte con el administrador del salón.',
      {
        status,
      },
    );
  }
}

export class EmailAlreadyRegisteredError extends ConflictError {
  constructor(email: string) {
    super('EMAIL_ALREADY_REGISTERED', 'Ya existe un usuario con ese correo electrónico', {
      email,
    });
  }
}

export class WeakPasswordError extends BusinessRuleViolationError {
  constructor(reasons: readonly string[]) {
    super('WEAK_PASSWORD', 'La contraseña no cumple los requisitos mínimos de seguridad', {
      reasons,
    });
  }
}

export class SamePasswordError extends BusinessRuleViolationError {
  constructor() {
    super('SAME_PASSWORD', 'La contraseña nueva debe ser distinta de la actual');
  }
}

/**
 * Se intenta dejar el salón sin ninguna propietaria.
 *
 * Regla de negocio real: sin nadie con permisos de administración, el salón queda
 * inoperable y solo se recupera con intervención manual sobre la base de datos.
 */
export class LastOwnerError extends BusinessRuleViolationError {
  constructor() {
    super(
      'LAST_OWNER',
      'No se puede desactivar ni degradar a la única propietaria del salón. Asigne antes ese rol a otro usuario.',
    );
  }
}

/** Detección de reutilización de refresh token: la firma de un token robado (ADR-0005). */
export class RefreshTokenReuseError extends BusinessRuleViolationError {
  constructor() {
    super(
      'REFRESH_TOKEN_REUSE_DETECTED',
      'Se ha detectado un uso indebido de la sesión. Todas las sesiones se han cerrado por seguridad; vuelva a iniciar sesión.',
    );
  }
}

export class InvalidRefreshTokenError extends AuthenticationError {
  public readonly code = 'INVALID_REFRESH_TOKEN';

  constructor() {
    super('La sesión no es válida o ha caducado');
  }
}
