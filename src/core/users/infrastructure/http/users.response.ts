import { ApiProperty } from '@nestjs/swagger';

import { EmptyEnvelopeResponse } from '../../../../shared/infrastructure/http/dto/response-envelope.dto';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { User, UserStatusValue } from '../../domain/user.entity';

export { EmptyEnvelopeResponse };

/**
 * Presentador de usuarios (ADR-0006).
 *
 * Los roles viajan como `{ id, code }`: los permisos de cada rol ya están fundidos en
 * `permissions`, la unión que de verdad decide qué puede hacer el usuario (ADR-0006).
 * Repetirlos por rol aquí solo invitaría a que alguien comprobara el permiso equivocado.
 */
export class UserRoleResponse {
  id!: string;
  code!: string;
}

export class UserResponse {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
  fullName!: string;
  phone!: string | null;
  status!: UserStatusValue;
  locale!: string;
  @ApiProperty({ type: [UserRoleResponse] }) roles!: UserRoleResponse[];
  @ApiProperty({ type: [String] }) permissions!: string[];
  lastLoginAt!: Date | null;
  createdAt!: Date;
  deletedAt!: Date | null;
}

export const toUserResponse = (u: User): UserResponse => ({
  id: u.id,
  email: u.email.value,
  firstName: u.name.firstName,
  lastName: u.name.lastName,
  fullName: u.name.full,
  phone: u.phone?.value ?? null,
  status: u.status,
  locale: u.locale,
  roles: u.roles.map((r) => ({ id: r.id, code: r.code })),
  permissions: u.effectivePermissions,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.audit.createdAt,
  deletedAt: u.audit.deletedAt,
});

export class UserEnvelopeResponse {
  @ApiProperty({ type: UserResponse }) data!: UserResponse;
}

export class UserPageResponse {
  @ApiProperty({ type: [UserResponse] }) data!: UserResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}
