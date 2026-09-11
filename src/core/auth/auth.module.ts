import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/infrastructure/config/env.schema';
import { UsersModule } from '../users/users.module';
import { LoginUseCase } from './application/login.use-case';
import { RefreshTokenUseCase } from './application/refresh-token.use-case';
import {
  ChangePasswordUseCase,
  GetCurrentUserUseCase,
  LogoutUseCase,
} from './application/session.use-cases';
import { AUTH_POLICY, type AuthPolicy } from './domain/auth-policy';
import { REFRESH_TOKEN_REPOSITORY } from './domain/refresh-token.repository';
import { AuthController } from './infrastructure/http/auth.controller';
import { PrismaRefreshTokenRepository } from './infrastructure/persistence/prisma-refresh-token.repository';
import {
  RequestPasswordResetUseCase,
  ResetPasswordUseCase,
} from './application/password-reset.use-cases';
import { PASSWORD_RESET_REPOSITORY } from './domain/password-reset.repository';
import { PrismaPasswordResetRepository } from './infrastructure/persistence/prisma-password-reset.repository';

/**
 * Módulo de autenticación.
 *
 * Este fichero es el **único** de todo el módulo donde se sabe que existen Prisma y las
 * variables de entorno. Los casos de uso solo conocen los puertos; el cableado vive aquí.
 * Sustituir el almacén de sesiones por Redis sería cambiar una línea de este fichero.
 */
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    LoginUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    ChangePasswordUseCase,
    GetCurrentUserUseCase,
    RequestPasswordResetUseCase,
    ResetPasswordUseCase,
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
    { provide: PASSWORD_RESET_REPOSITORY, useClass: PrismaPasswordResetRepository },
    {
      // La política se traduce aquí desde el entorno, de modo que el caso de uso reciba
      // dos números y no una dependencia de infraestructura (ADR-0001).
      provide: AUTH_POLICY,
      useFactory: (config: ConfigService<Env, true>): AuthPolicy => ({
        maxFailedLoginAttempts: config.get('MAX_FAILED_LOGIN_ATTEMPTS', { infer: true }),
        accountLockMinutes: config.get('ACCOUNT_LOCK_MINUTES', { infer: true }),
      }),
      inject: [ConfigService],
    },
  ],
  exports: [GetCurrentUserUseCase],
})
export class AuthModule {}
