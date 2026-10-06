/** Aviso pendiente tal como lo ve la propietaria en Equipo. */
export interface PendingPasswordResetRequest {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly requestedAt: Date;
}

/**
 * Solicitudes de «olvidé mi contraseña» dirigidas a la propietaria del salón.
 *
 * `open` se llama desde el formulario público, cuando aún no hay salón en contexto: la
 * implementación fija el `tenantId` a mano. El resto se ejecuta con la sesión de la
 * propietaria y queda acotado a su salón.
 */
export interface PasswordResetRequestRepository {
  /** Registra el aviso salvo que el usuario ya tenga uno pendiente. */
  open(request: { id: string; tenantId: string; userId: string; now: Date }): Promise<void>;
  /** Avisos pendientes del salón activo, de usuarios que siguen pudiendo entrar. */
  listPending(): Promise<PendingPasswordResetRequest[]>;
  /** Cierra el aviso pendiente del usuario, si lo hay, porque ya tiene contraseña nueva. */
  resolveForUser(userId: string, actorId: string, now: Date): Promise<void>;
  /** Descarta un aviso pendiente del salón activo. `false` si no existe o ya estaba cerrado. */
  dismiss(id: string, actorId: string, now: Date): Promise<boolean>;
}

export const PASSWORD_RESET_REQUEST_REPOSITORY = Symbol('PasswordResetRequestRepository');
