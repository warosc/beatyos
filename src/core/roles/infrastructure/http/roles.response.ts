import { ApiProperty } from '@nestjs/swagger';

import { EmptyEnvelopeResponse } from '../../../../shared/infrastructure/http/dto/response-envelope.dto';
import type { RoleRecord } from '../../domain/role.repository';

export { EmptyEnvelopeResponse };

/**
 * Presentadores de roles (ADR-0006).
 *
 * `RoleRecord` ya trae exactamente la forma que espera `apps/web` —lo compone el
 * repositorio uniendo `Role` y sus `RolePermission`—, así que el presentador solo copia el
 * tipo a una clase para que el plugin de Swagger pueda describirlo.
 */
export class RoleResponse {
  id!: string;
  tenantId!: string | null;
  code!: string;
  name!: string;
  description!: string | null;
  isSystem!: boolean;
  @ApiProperty({ type: [String] }) permissions!: string[];
  userCount!: number;
}

export const toRoleResponse = (role: RoleRecord): RoleResponse => ({
  id: role.id,
  tenantId: role.tenantId,
  code: role.code,
  name: role.name,
  description: role.description,
  isSystem: role.isSystem,
  permissions: [...role.permissions],
  userCount: role.userCount,
});

/** Catálogo de permisos: fijo, sin paginar (ADR-0006). */
export class PermissionResponse {
  code!: string;
  resource!: string;
  action!: string;
  description!: string;
}

export class RoleListEnvelopeResponse {
  @ApiProperty({ type: [RoleResponse] }) data!: RoleResponse[];
}

export class RoleEnvelopeResponse {
  @ApiProperty({ type: RoleResponse }) data!: RoleResponse;
}

export class PermissionListEnvelopeResponse {
  @ApiProperty({ type: [PermissionResponse] }) data!: PermissionResponse[];
}
