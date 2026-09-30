import { Injectable } from '@nestjs/common';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import type {
  TenantProfile,
  TenantProfilePatch,
  TenantProfileRepository,
} from '../../domain/tenant-profile.repository';

const select = {
  id: true,
  name: true,
  legalName: true,
  taxId: true,
  addressLine: true,
  city: true,
  phone: true,
  email: true,
  brandTheme: true,
  receiptNote: true,
} as const;

/**
 * `Tenant` está exento del filtro automático por salón (es el salón mismo), así que cada
 * consulta lleva el identificador explícito: nunca se lee ni se escribe otro salón.
 */
@Injectable()
export class PrismaTenantProfileRepository implements TenantProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(tenantId: string): Promise<TenantProfile> {
    const row = await this.prisma.client.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select,
    });
    if (!row) throw new EntityNotFoundError('Salón', tenantId);
    return row;
  }

  async update(
    tenantId: string,
    patch: TenantProfilePatch,
    actorId: string,
  ): Promise<TenantProfile> {
    await this.find(tenantId);
    return this.prisma.client.tenant.update({
      where: { id: tenantId },
      data: { ...patch, updatedBy: actorId },
      select,
    });
  }
}
