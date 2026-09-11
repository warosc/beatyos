import { Module } from '@nestjs/common';

import { USER_REPOSITORY } from './domain/user.repository';
import { PrismaUserRepository } from './infrastructure/persistence/prisma-user.repository';
import { RolesModule } from '../roles/roles.module';
import {
  CreateUserUseCase,
  SearchUsersUseCase,
  UpdateUserUseCase,
} from './application/user-admin.use-cases';
import { UsersController } from './infrastructure/http/users.controller';

/**
 * Módulo de identidad.
 *
 * Solo publica el **puerto**, nunca la clase concreta. Quien lo importe inyecta
 * `USER_REPOSITORY` y no puede acoplarse a Prisma ni por descuido: no tiene forma de
 * nombrar `PrismaUserRepository` sin saltarse el `exports`, que es justamente la barrera
 * que hace exigible el ADR-0001 en lugar de dejarlo en una buena intención.
 */
@Module({
  imports: [RolesModule],
  controllers: [UsersController],
  providers: [
    CreateUserUseCase,
    SearchUsersUseCase,
    UpdateUserUseCase,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
  ],
  exports: [USER_REPOSITORY],
})
export class UsersModule {}
