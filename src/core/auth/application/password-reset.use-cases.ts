import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_RECORDER,
  CLOCK,
  EMAIL_SENDER,
  ID_GENERATOR,
  PASSWORD_HASHER,
  type AuditRecorder,
  type Clock,
  type EmailSender,
  type IdGenerator,
  type PasswordHasher,
  type UseCase,
} from '../../../shared/application/ports';
import {
  AuthenticationError,
  EntityNotFoundError,
  ForbiddenActionError,
} from '../../../shared/domain/errors';
import { USER_REPOSITORY, type UserRepository } from '../../users/domain/user.repository';
import { User } from '../../users/domain/user.entity';
import {
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepository,
} from '../domain/password-reset.repository';
import {
  PASSWORD_RESET_REQUEST_REPOSITORY,
  type PasswordResetRequestRepository,
  type PendingPasswordResetRequest,
} from '../domain/password-reset-request.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepository,
} from '../domain/refresh-token.repository';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
class InvalidPasswordResetTokenError extends AuthenticationError {
  readonly code = 'INVALID_PASSWORD_RESET_TOKEN';
  constructor(message = 'El enlace de recuperación no es válido o ya venció') {
    super(message);
  }
}

@Injectable()
export class RequestPasswordResetUseCase implements UseCase<
  { email: string },
  { token: string | null }
> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly resets: PasswordResetRepository,
    @Inject(PASSWORD_RESET_REQUEST_REPOSITORY)
    private readonly requests: PasswordResetRequestRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async execute(input: { email: string }): Promise<{ token: string | null }> {
    const user = await this.users.findByEmailAcrossTenants(input.email);
    if (!user || !user.isActive()) return { token: null };
    const token = `${this.ids.generate()}${this.ids.generate().replaceAll('-', '')}`;
    const now = this.clock.now();
    await this.resets.replaceForUser({
      id: this.ids.generate(),
      userId: user.id,
      tokenHash: digest(token),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    // Mientras no haya proveedor de correo, el aviso a la propietaria es la vía que de
    // verdad devuelve el acceso: ella asigna una contraseña nueva desde Equipo. Las cuentas
    // de plataforma no tienen salón ni, por tanto, propietaria a quien avisar.
    if (user.tenantId)
      await this.requests.open({
        id: this.ids.generate(),
        tenantId: user.tenantId,
        userId: user.id,
        now,
      });
    // El correo es la vía por la que el token llega a su dueño. Un fallo del proveedor no
    // puede propagarse: haría que el endpoint respondiera distinto según el correo exista
    // o no, que es justo la fuga que el `return { token: null }` de arriba evita.
    await this.email
      .send({
        to: user.email.value,
        subject: 'Recuperación de acceso',
        body:
          `Hola ${user.name.firstName}:\n\n` +
          `Para establecer una contraseña nueva, abra el siguiente enlace. Caduca en 30 ` +
          `minutos y solo puede usarse una vez.\n\n/reset-password?token=${token}\n\n` +
          `Si no ha pedido usted este cambio, ignore este mensaje: su contraseña actual ` +
          `sigue siendo válida.`,
      })
      .catch(() => undefined);
    return { token };
  }
}

@Injectable()
export class ResetPasswordUseCase implements UseCase<{ token: string; newPassword: string }, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly resets: PasswordResetRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { token: string; newPassword: string }): Promise<void> {
    User.validatePasswordStrength(input.newPassword);
    const now = this.clock.now();
    const reset = await this.resets.findByHash(digest(input.token));
    if (!reset || reset.usedAt || reset.expiresAt <= now)
      throw new InvalidPasswordResetTokenError();
    const user = await this.users.findByIdAcrossTenants(reset.userId);
    if (!user || !user.isActive()) throw new InvalidPasswordResetTokenError();
    if (!(await this.resets.markUsed(reset.id, now)))
      throw new InvalidPasswordResetTokenError('El enlace de recuperación ya fue utilizado');
    const hash = await this.hasher.hash(input.newPassword);
    user.changePassword(hash, now, user.id);
    await this.users.update(user);

    // Recuperar la contraseña es, muchas veces, la reacción a que otra persona la conocía:
    // sus sesiones abiertas tienen que caer aquí, igual que al cambiarla desde el perfil.
    await this.refreshTokens.revokeAllForUser(user.id, 'PASSWORD_RESET', now);
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      metadata: { field: 'password', resetByLink: true, sessionsRevoked: true },
    });
  }
}

export interface AdminResetPasswordInput {
  readonly userId: string;
  readonly newPassword: string;
  readonly actorId: string;
}

/**
 * Contraseña nueva asignada por la propietaria a alguien de su equipo.
 *
 * Es la otra mitad de «olvidé mi contraseña»: quien la olvidó avisa, la propietaria le
 * asigna una y se la comunica en persona. No se pide la contraseña actual —es justo la
 * que se ha perdido—; lo que protege la operación es el permiso, que solo tiene la
 * propiedad, y que el usuario tiene que ser del mismo salón (`findById` está acotado).
 */
@Injectable()
export class AdminResetPasswordUseCase implements UseCase<AdminResetPasswordInput, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(PASSWORD_RESET_REQUEST_REPOSITORY)
    private readonly requests: PasswordResetRequestRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: AdminResetPasswordInput): Promise<void> {
    // La propia se cambia desde el perfil, que exige la actual: si no, cualquiera que pase
    // por una sesión abierta de la propietaria podría quedarse con su cuenta.
    if (input.userId === input.actorId)
      throw new ForbiddenActionError(
        'users.reset-password',
        'Para cambiar su propia contraseña use «Perfil y ajustes».',
      );
    const user = await this.users.findById(input.userId);
    if (!user) throw new EntityNotFoundError('Usuario', input.userId);

    User.validatePasswordStrength(input.newPassword);
    const now = this.clock.now();
    user.changePassword(await this.hasher.hash(input.newPassword), now, input.actorId);
    await this.users.update(user);

    // Si el cambio se pidió porque alguien más conocía la contraseña, sus sesiones caen aquí.
    await this.refreshTokens.revokeAllForUser(user.id, 'PASSWORD_RESET_BY_ADMIN', now);
    await this.requests.resolveForUser(user.id, input.actorId, now);
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      metadata: { field: 'password', resetByAdmin: true, sessionsRevoked: true },
    });
  }
}

/** Bandeja de avisos de «olvidé mi contraseña» que ve la propietaria. */
@Injectable()
export class PasswordResetRequestsUseCase {
  constructor(
    @Inject(PASSWORD_RESET_REQUEST_REPOSITORY)
    private readonly requests: PasswordResetRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  list(): Promise<PendingPasswordResetRequest[]> {
    return this.requests.listPending();
  }

  /** Para avisos que no pidió quien dice el correo o que ya se resolvieron en persona. */
  async dismiss(id: string, actorId: string): Promise<void> {
    if (!(await this.requests.dismiss(id, actorId, this.clock.now())))
      throw new EntityNotFoundError('Solicitud de contraseña', id);
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'PasswordResetRequest',
      entityId: id,
      metadata: { status: 'DISMISSED' },
    });
  }
}
