import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_RECORDER, type AuditRecorder } from '../../../shared/application/ports';
import {
  TENANT_PROFILE_REPOSITORY,
  type TenantProfilePatch,
  type TenantProfileRepository,
} from '../domain/tenant-profile.repository';

@Injectable()
export class GetTenantProfileUseCase {
  constructor(@Inject(TENANT_PROFILE_REPOSITORY) private profiles: TenantProfileRepository) {}
  execute(tenantId: string) {
    return this.profiles.find(tenantId);
  }
}

@Injectable()
export class UpdateTenantProfileUseCase {
  constructor(
    @Inject(TENANT_PROFILE_REPOSITORY) private profiles: TenantProfileRepository,
    @Inject(AUDIT_RECORDER) private audit: AuditRecorder,
  ) {}
  async execute(input: { tenantId: string; patch: TenantProfilePatch; actorId: string }) {
    const before = await this.profiles.find(input.tenantId);
    // Un campo vacío se guarda como ausente: en el comprobante no debe salir «NIT: ».
    const patch = Object.fromEntries(
      Object.entries(input.patch).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() || null : value,
      ]),
    ) as TenantProfilePatch;
    const after = await this.profiles.update(input.tenantId, patch, input.actorId);
    // Son los datos que aparecen en lo que se entrega a la clienta: queda quién los cambió.
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Tenant',
      entityId: input.tenantId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }
}
