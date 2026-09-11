import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  PASSWORD_HASHER,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type PasswordHasher,
} from '../../../shared/application/ports';
import { EntityNotFoundError } from '../../../shared/domain/errors';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { ROLE_REPOSITORY, type RoleRepository } from '../../roles/domain/role.repository';
import { User, type UserStatusValue } from '../domain/user.entity';
import { EmailAlreadyRegisteredError, LastOwnerError } from '../domain/user.errors';
import { USER_REPOSITORY, type UserRepository } from '../domain/user.repository';

const assigned = (roles: Awaited<ReturnType<RoleRepository['listAvailable']>>) =>
  roles.map((r) => ({ id: r.id, code: r.code, permissions: r.permissions }));
@Injectable()
export class SearchUsersUseCase {
  constructor(@Inject(USER_REPOSITORY) private users: UserRepository) {}
  execute(input: {
    search?: string;
    status?: UserStatusValue;
    roleCode?: string;
    page: number;
    limit: number;
  }) {
    return this.users.search(input, {
      page: input.page,
      limit: input.limit,
      sort: [{ field: 'lastName', direction: 'asc' }],
    });
  }
  async detail(id: string) {
    const user = await this.users.findById(id, { includeDeleted: true });
    if (!user) throw new EntityNotFoundError('Usuario', id);
    return user;
  }
}
@Injectable()
export class CreateUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private users: UserRepository,
    @Inject(ROLE_REPOSITORY) private roles: RoleRepository,
    @Inject(PASSWORD_HASHER) private hasher: PasswordHasher,
    @Inject(ID_GENERATOR) private ids: IdGenerator,
    @Inject(CLOCK) private clock: Clock,
    @Inject(AUDIT_RECORDER) private audit: AuditRecorder,
  ) {}
  async execute(input: {
    tenantId: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    roleIds: string[];
    actorId: string;
  }) {
    User.validatePasswordStrength(input.password);
    if (await this.users.existsByEmail(input.email))
      throw new EmailAlreadyRegisteredError(input.email);
    const roles = await this.roles.findAvailableByIds(input.tenantId, input.roleIds);
    if (roles.length !== new Set(input.roleIds).size)
      throw new EntityNotFoundError('Rol', 'uno o más identificadores');
    const user = User.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      email: Email.create(input.email),
      passwordHash: await this.hasher.hash(input.password),
      name: PersonName.create(input.firstName, input.lastName),
      phone: Phone.createOptional(input.phone),
      roles: assigned(roles),
      now: this.clock.now(),
      actorId: input.actorId,
    });
    const saved = await this.users.create(user);
    await this.audit.record({ action: 'CREATE', entityType: 'User', entityId: saved.id });
    return saved;
  }
}
@Injectable()
export class UpdateUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private users: UserRepository,
    @Inject(ROLE_REPOSITORY) private roles: RoleRepository,
    @Inject(CLOCK) private clock: Clock,
    @Inject(AUDIT_RECORDER) private audit: AuditRecorder,
  ) {}
  private async get(id: string) {
    const user = await this.users.findById(id, { includeDeleted: true });
    if (!user) throw new EntityNotFoundError('Usuario', id);
    return user;
  }
  async profile(input: {
    id: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
    actorId: string;
  }) {
    const user = await this.get(input.id);
    if (
      input.status === 'INACTIVE' &&
      user.roleCodes.includes('OWNER') &&
      (await this.users.countActiveOwners(user.id)) === 0
    )
      throw new LastOwnerError();
    user.updateProfile(
      {
        name:
          input.firstName || input.lastName
            ? PersonName.create(
                input.firstName ?? user.name.firstName,
                input.lastName ?? user.name.lastName,
              )
            : undefined,
        phone: input.phone !== undefined ? Phone.createOptional(input.phone) : undefined,
      },
      this.clock.now(),
      input.actorId,
    );
    if (input.status === 'ACTIVE') user.activate(this.clock.now(), input.actorId);
    if (input.status === 'INACTIVE') user.deactivate(this.clock.now(), input.actorId);
    const saved = await this.users.update(user);
    await this.audit.record({ action: 'UPDATE', entityType: 'User', entityId: user.id });
    return saved;
  }
  async assign(input: { id: string; tenantId: string; roleIds: string[]; actorId: string }) {
    const user = await this.get(input.id);
    const roles = await this.roles.findAvailableByIds(input.tenantId, input.roleIds);
    if (roles.length !== new Set(input.roleIds).size)
      throw new EntityNotFoundError('Rol', 'uno o más identificadores');
    if (
      user.roleCodes.includes('OWNER') &&
      !roles.some((r) => r.code === 'OWNER') &&
      (await this.users.countActiveOwners(user.id)) === 0
    )
      throw new LastOwnerError();
    user.assignRoles(assigned(roles), this.clock.now(), input.actorId);
    const saved = await this.users.update(user);
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      metadata: { rolesChanged: true },
    });
    return saved;
  }
  async remove(id: string, actorId: string) {
    const user = await this.get(id);
    if (user.roleCodes.includes('OWNER') && (await this.users.countActiveOwners(user.id)) === 0)
      throw new LastOwnerError();
    await this.users.softDelete(id, actorId);
    await this.audit.record({ action: 'DELETE', entityType: 'User', entityId: id });
  }
  async restore(id: string, actorId: string) {
    const user = await this.users.restore(id, actorId);
    await this.audit.record({ action: 'RESTORE', entityType: 'User', entityId: id });
    return user;
  }
}
