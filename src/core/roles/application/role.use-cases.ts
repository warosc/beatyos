import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../../shared/application/ports';
import { ROLE_REPOSITORY, type RoleRepository } from '../domain/role.repository';
@Injectable()
export class ListRolesUseCase {
  constructor(@Inject(ROLE_REPOSITORY) private r: RoleRepository) {}
  execute(tenantId: string) {
    return this.r.listAvailable(tenantId);
  }
  permissions() {
    return this.r.listPermissions();
  }
}
@Injectable()
export class CreateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private r: RoleRepository,
    @Inject(ID_GENERATOR) private ids: IdGenerator,
  ) {}
  execute(input: {
    tenantId: string;
    code: string;
    name: string;
    description: string | null;
    permissionCodes: string[];
    actorId: string;
  }) {
    return this.r.create({
      ...input,
      id: this.ids.generate(),
      code: input.code.trim().toUpperCase(),
    });
  }
}
@Injectable()
export class UpdateRoleUseCase {
  constructor(@Inject(ROLE_REPOSITORY) private r: RoleRepository) {}
  execute(input: {
    id: string;
    tenantId: string;
    name?: string;
    description?: string | null;
    permissionCodes?: string[];
    actorId: string;
  }) {
    return this.r.update(input);
  }
  delete(id: string, tenantId: string, actorId: string) {
    return this.r.delete(id, tenantId, actorId);
  }
}
