import { Module } from '@nestjs/common';
import {
  GetTenantProfileUseCase,
  UpdateTenantProfileUseCase,
} from './application/tenant-profile.use-cases';
import { TENANT_PROFILE_REPOSITORY } from './domain/tenant-profile.repository';
import { TenantController } from './infrastructure/http/tenant.controller';
import { PrismaTenantProfileRepository } from './infrastructure/persistence/prisma-tenant-profile.repository';

@Module({
  controllers: [TenantController],
  providers: [
    GetTenantProfileUseCase,
    UpdateTenantProfileUseCase,
    { provide: TENANT_PROFILE_REPOSITORY, useClass: PrismaTenantProfileRepository },
  ],
})
export class TenantsModule {}
