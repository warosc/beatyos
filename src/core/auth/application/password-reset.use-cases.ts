import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  EMAIL_SENDER,
  ID_GENERATOR,
  PASSWORD_HASHER,
  type Clock,
  type EmailSender,
  type IdGenerator,
  type PasswordHasher,
  type UseCase,
} from '../../../shared/application/ports';
import { AuthenticationError } from '../../../shared/domain/errors';
import { USER_REPOSITORY, type UserRepository } from '../../users/domain/user.repository';
import { User } from '../../users/domain/user.entity';
import {
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepository,
} from '../domain/password-reset.repository';

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
    @Inject(CLOCK) private readonly clock: Clock,
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
  }
}
