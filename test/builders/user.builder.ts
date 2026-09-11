import { Email, PersonName, Phone } from '@shared/domain/value-objects/contact.vo';
import { User, type AssignedRole, type UserStatusValue } from '@core/users/domain/user.entity';

/**
 * Constructor de usuarios para tests.
 *
 * Un test debe decir **solo lo que le importa**. `aUser().locked(until).build()` se lee
 * de un vistazo; construir el agregado entero con quince campos entierra la condición
 * que se está probando bajo el ruido de los otros catorce.
 *
 * Los valores por defecto son deliberadamente válidos y aburridos, de modo que cualquier
 * cosa llamativa en un test sea, por fuerza, relevante para ese test.
 */

export const TENANT_A = '11111111-1111-7111-8111-111111111111';
export const TENANT_B = '22222222-2222-7222-8222-222222222222';

export const OWNER_ROLE: AssignedRole = {
  id: 'role-owner',
  code: 'OWNER',
  permissions: ['clients.read', 'clients.create', 'appointments.read', 'reports.financial'],
};

export const STYLIST_ROLE: AssignedRole = {
  id: 'role-stylist',
  code: 'STYLIST',
  permissions: ['appointments.read.own', 'clients.read'],
};

export const RECEPTIONIST_ROLE: AssignedRole = {
  id: 'role-receptionist',
  code: 'RECEPTIONIST',
  permissions: ['appointments.read', 'appointments.create', 'clients.read'],
};

let sequence = 0;

export class UserBuilder {
  private id = `user-${(sequence += 1)}`;
  private tenantId: string | null = TENANT_A;
  private email = `usuario${sequence}@salon.test`;
  private passwordHash = '$fake$ContrasenaSegura1';
  private firstName = 'Ana';
  private lastName = 'García';
  private phone: string | null = null;
  private status: UserStatusValue = 'ACTIVE';
  private roles: AssignedRole[] = [OWNER_ROLE];
  private createdAt = new Date('2026-01-01T09:00:00.000Z');
  private tokenVersion = 0;
  private failedAttempts = 0;
  private lockedUntil: Date | null = null;
  private deletedAt: Date | null = null;
  private lastLoginAt: Date | null = null;

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withEmail(email: string): this {
    this.email = email;
    return this;
  }

  /** Contraseña en claro; se guarda con el formato del `FakePasswordHasher`. */
  withPassword(plain: string): this {
    this.passwordHash = `$fake$${plain}`;
    return this;
  }

  withRealPasswordHash(hash: string): this {
    this.passwordHash = hash;
    return this;
  }

  inTenant(tenantId: string | null): this {
    this.tenantId = tenantId;
    return this;
  }

  withRoles(...roles: AssignedRole[]): this {
    this.roles = roles;
    return this;
  }

  withStatus(status: UserStatusValue): this {
    this.status = status;
    return this;
  }

  inactive(): this {
    this.status = 'INACTIVE';
    return this;
  }

  locked(until: Date, attempts = 5): this {
    this.lockedUntil = until;
    this.failedAttempts = attempts;
    return this;
  }

  withFailedAttempts(attempts: number): this {
    this.failedAttempts = attempts;
    return this;
  }

  withTokenVersion(version: number): this {
    this.tokenVersion = version;
    return this;
  }

  deleted(at = new Date('2026-02-01T00:00:00.000Z')): this {
    this.deletedAt = at;
    return this;
  }

  withPhone(phone: string): this {
    this.phone = phone;
    return this;
  }

  build(): User {
    return User.rehydrate(this.id, {
      tenantId: this.tenantId,
      email: Email.create(this.email),
      passwordHash: this.passwordHash,
      name: PersonName.create(this.firstName, this.lastName),
      phone: this.phone ? Phone.create(this.phone) : null,
      avatarUrl: null,
      status: this.status,
      locale: 'es-ES',
      emailVerifiedAt: null,
      lastLoginAt: this.lastLoginAt,
      tokenVersion: this.tokenVersion,
      failedLoginAttempts: this.failedAttempts,
      lockedUntil: this.lockedUntil,
      roles: this.roles,
      audit: {
        createdAt: this.createdAt,
        updatedAt: this.createdAt,
        deletedAt: this.deletedAt,
        createdBy: null,
        updatedBy: null,
        deletedBy: null,
      },
    });
  }
}

export const aUser = (): UserBuilder => new UserBuilder();
