export interface RoleRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
  readonly userCount: number;
}
export interface RoleRepository {
  listAvailable(tenantId: string): Promise<RoleRecord[]>;
  findAvailableByIds(tenantId: string, ids: readonly string[]): Promise<RoleRecord[]>;
  listPermissions(): Promise<
    { code: string; resource: string; action: string; description: string }[]
  >;
  create(input: {
    id: string;
    tenantId: string;
    code: string;
    name: string;
    description: string | null;
    permissionCodes: readonly string[];
    actorId: string;
  }): Promise<RoleRecord>;
  update(input: {
    id: string;
    tenantId: string;
    name?: string;
    description?: string | null;
    permissionCodes?: readonly string[];
    actorId: string;
  }): Promise<RoleRecord>;
  delete(id: string, tenantId: string, actorId: string): Promise<void>;
}
export const ROLE_REPOSITORY = Symbol('RoleRepository');
