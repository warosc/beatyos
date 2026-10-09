/**
 * Cómo se llaman en el salón los códigos que devuelve la API.
 *
 * La API habla en códigos estables (`SALE_OUT`, `PARTIALLY_RECEIVED`, `RECEPTIONIST`); la
 * pantalla nunca debe enseñarlos tal cual. Si llega un código nuevo que aún no está aquí,
 * `label()` lo muestra antes que dejar el hueco vacío.
 */
export const label = (labels: Record<string, string>, code: string) => labels[code] ?? code;

/** Tipos de movimiento del kardex. */
export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  PURCHASE_IN: 'Compra',
  SALE_OUT: 'Venta',
  SERVICE_CONSUMPTION: 'Consumo en servicio',
  ADJUSTMENT: 'Ajuste',
  RETURN_IN: 'Devolución',
  WASTE_OUT: 'Merma',
  INITIAL_STOCK: 'Existencia inicial',
};

/** Estados de una orden de compra. */
export const PURCHASE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Borrador',
  SUBMITTED: 'Enviada',
  PARTIALLY_RECEIVED: 'Recibida en parte',
  RECEIVED: 'Recibida',
  CANCELLED: 'Cancelada',
};

/** Estados de un usuario del equipo. */
export const USER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo',
  INACTIVE: 'Inactivo',
  SUSPENDED: 'Suspendido',
  PENDING_VERIFICATION: 'Pendiente de verificar',
};

/** Estados de una clienta. */
export const CLIENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activa',
  INACTIVE: 'Inactiva',
  BLOCKED: 'Bloqueada',
};

/** Roles de sistema; los roles propios del salón ya traen su nombre. */
export const ROLE_LABEL: Record<string, string> = {
  PLATFORM_ADMIN: 'Administración de plataforma',
  OWNER: 'Propietaria',
  MANAGER: 'Encargada',
  RECEPTIONIST: 'Recepción',
  STYLIST: 'Profesional',
};

/** Grupos de permisos, para el editor de roles. */
export const PERMISSION_RESOURCE_LABEL: Record<string, string> = {
  appointments: 'Agenda',
  audit: 'Auditoría',
  cash: 'Caja',
  categories: 'Categorías',
  clients: 'Clientas',
  goals: 'Metas',
  inventory: 'Inventario',
  invoices: 'Ventas',
  payments: 'Cobros',
  products: 'Productos',
  purchases: 'Compras',
  reports: 'Reportes',
  roles: 'Roles',
  'service-tickets': 'Servicios por cobrar',
  services: 'Servicios',
  settings: 'Datos del salón',
  stylists: 'Profesionales',
  suppliers: 'Proveedores',
  users: 'Usuarios',
};
