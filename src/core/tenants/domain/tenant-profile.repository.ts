/**
 * Combinaciones de colores que un salón puede elegir. La lista vive aquí y no en la base:
 * cada identificador corresponde a una paleta que la interfaz sabe pintar.
 */
export const BRAND_THEMES = ['terracota', 'menta-rosa', 'rosa-menta', 'lavanda'] as const;
export type BrandTheme = (typeof BRAND_THEMES)[number];

/**
 * Datos del salón: lo que sale impreso en los comprobantes y cómo se ve su interfaz.
 *
 * Es un registro y no un agregado: no tiene más reglas que su formato, y el resto del
 * `Tenant` —plan, estado, zona horaria— es de la plataforma y no se toca desde aquí.
 */
export interface TenantProfile {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  /** NIT en Guatemala. */
  readonly taxId: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly phone: string | null;
  readonly email: string;
  readonly brandTheme: string;
  /** Línea libre al pie de los comprobantes. */
  readonly receiptNote: string | null;
}

export type TenantProfilePatch = Partial<Omit<TenantProfile, 'id'>>;

export interface TenantProfileRepository {
  find(tenantId: string): Promise<TenantProfile>;
  update(tenantId: string, patch: TenantProfilePatch, actorId: string): Promise<TenantProfile>;
}

export const TENANT_PROFILE_REPOSITORY = Symbol('TenantProfileRepository');
