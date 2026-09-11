import { Module } from '@nestjs/common';
import {
  CreateRoleUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from './application/role.use-cases';
import { ROLE_REPOSITORY } from './domain/role.repository';
import { RolesController } from './infrastructure/http/roles.controller';
import { PrismaRoleRepository } from './infrastructure/persistence/prisma-role.repository';
@Module({
  controllers: [RolesController],
  providers: [
    ListRolesUseCase,
    CreateRoleUseCase,
    UpdateRoleUseCase,
    { provide: ROLE_REPOSITORY, useClass: PrismaRoleRepository },
  ],
  exports: [ROLE_REPOSITORY],
})
export class RolesModule {}
