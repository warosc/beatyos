import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ConflictError, EntityNotFoundError } from '../../../../shared/domain/errors';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import type { RoleRecord, RoleRepository } from '../../domain/role.repository';

const include = {
  permissions: { include: { permission: true } },
  _count: { select: { users: true } },
} as const;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof include }>;
@Injectable()
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaService) {}
  private present(row: RoleRow): RoleRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      code: row.code,
      name: row.name,
      description: row.description,
      isSystem: row.isSystem,
      permissions: row.permissions.map((x) => x.permission.code).sort(),
      userCount: row._count.users,
    };
  }
  async listAvailable(tenantId: string) {
    return QueryScopeStore.crossTenant(async () =>
      (
        await this.prisma.client.role.findMany({
          where: { OR: [{ tenantId: null, isSystem: true }, { tenantId }], deletedAt: null },
          include,
          orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        })
      ).map((x) => this.present(x)),
    );
  }
  async findAvailableByIds(tenantId: string, ids: readonly string[]) {
    return QueryScopeStore.crossTenant(async () =>
      (
        await this.prisma.client.role.findMany({
          where: {
            id: { in: [...ids] },
            OR: [{ tenantId: null, isSystem: true }, { tenantId }],
            deletedAt: null,
          },
          include,
        })
      ).map((x) => this.present(x)),
    );
  }
  async listPermissions() {
    return this.prisma.client.permission.findMany({
      select: { code: true, resource: true, action: true, description: true },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }
  async create(input: {
    id: string;
    tenantId: string;
    code: string;
    name: string;
    description: string | null;
    permissionCodes: readonly string[];
    actorId: string;
  }) {
    return QueryScopeStore.crossTenant(async () => {
      const duplicate = await this.prisma.client.role.findFirst({
        where: { tenantId: input.tenantId, code: input.code, deletedAt: null },
      });
      if (duplicate) throw new ConflictError('ROLE_CODE_EXISTS', 'Ya existe un rol con ese código');
      const permissions = await this.prisma.client.permission.findMany({
        where: { code: { in: [...input.permissionCodes] } },
        select: { id: true },
      });
      if (permissions.length !== input.permissionCodes.length)
        throw new EntityNotFoundError('Permiso', 'uno o más códigos');
      const row = await this.prisma.client.role.create({
        data: {
          id: input.id,
          tenantId: input.tenantId,
          code: input.code,
          name: input.name,
          description: input.description,
          createdBy: input.actorId,
          updatedBy: input.actorId,
          permissions: {
            create: permissions.map((p) => ({ permissionId: p.id, grantedBy: input.actorId })),
          },
        },
        include,
      });
      return this.present(row);
    });
  }
  async update(input: {
    id: string;
    tenantId: string;
    name?: string;
    description?: string | null;
    permissionCodes?: readonly string[];
    actorId: string;
  }) {
    return QueryScopeStore.crossTenant(() =>
      this.prisma.transaction(async () => {
        const current = await this.prisma.client.role.findFirst({
          where: { id: input.id, tenantId: input.tenantId, isSystem: false, deletedAt: null },
        });
        if (!current) throw new EntityNotFoundError('Rol editable', input.id);
        if (input.permissionCodes) {
          const permissions = await this.prisma.client.permission.findMany({
            where: { code: { in: [...input.permissionCodes] } },
            select: { id: true },
          });
          if (permissions.length !== input.permissionCodes.length)
            throw new EntityNotFoundError('Permiso', 'uno o más códigos');
          await this.prisma.client.rolePermission.deleteMany({ where: { roleId: input.id } });
          await this.prisma.client.rolePermission.createMany({
            data: permissions.map((p) => ({
              roleId: input.id,
              permissionId: p.id,
              grantedBy: input.actorId,
            })),
          });
        }
        const row = await this.prisma.client.role.update({
          where: { id: input.id },
          data: { name: input.name, description: input.description, updatedBy: input.actorId },
          include,
        });
        return this.present(row);
      }),
    );
  }
  async delete(id: string, tenantId: string, actorId: string) {
    await QueryScopeStore.crossTenant(async () => {
      const role = await this.prisma.client.role.findFirst({
        where: { id, tenantId, isSystem: false, deletedAt: null },
        include: { _count: { select: { users: true } } },
      });
      if (!role) throw new EntityNotFoundError('Rol editable', id);
      if (role._count.users)
        throw new ConflictError('ROLE_IN_USE', 'No se puede eliminar un rol asignado a usuarios');
      await this.prisma.client.role.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: actorId, updatedBy: actorId },
      });
    });
  }
}
