/**
 * Catálogo de permisos y roles del sistema (ADR-0006).
 *
 * Es la **única** fuente de verdad de qué acciones existen. El seed la vuelca en la
 * tabla `Permission`, los controladores la referencian en `@RequirePermissions` y los
 * roles del sistema se componen a partir de ella.
 *
 * Está en el dominio, no en un fichero de configuración, por una razón práctica:
 * escribiendo `PERMISSIONS.appointments.create` en el controlador, renombrar un permiso
 * rompe la compilación. Con una cadena suelta, `'appointments.crate'` se despliega y
 * cierra el endpoint a todo el mundo en silencio.
 */

interface PermissionDefinition {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

const define = (resource: string, action: string, description: string): PermissionDefinition => ({
  code: `${resource}.${action}`,
  resource,
  action,
  description,
});

/**
 * Sufijo de ámbito propio.
 *
 * `appointments.read` ve toda la agenda del salón; `appointments.read.own` solo la del
 * profesional que consulta. El guard trata ambos como permisos distintos; **es el caso
 * de uso quien restringe las filas**, porque "cuáles son mías" es una regla de negocio
 * y no algo que un guard de transporte pueda saber.
 */
export const OWN_SCOPE_SUFFIX = '.own';

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  // --- Usuarios, roles y auditoría ----------------------------------------
  define('users', 'read', 'Ver usuarios del salón'),
  define('users', 'create', 'Dar de alta usuarios'),
  define('users', 'update', 'Modificar usuarios'),
  define('users', 'delete', 'Dar de baja usuarios'),
  define('users', 'restore', 'Recuperar usuarios dados de baja'),
  define('users', 'assign-roles', 'Asignar roles a un usuario'),

  define('roles', 'read', 'Ver roles y sus permisos'),
  define('roles', 'create', 'Crear roles propios del salón'),
  define('roles', 'update', 'Modificar roles propios del salón'),
  define('roles', 'delete', 'Eliminar roles propios del salón'),

  define('audit', 'read', 'Consultar el registro de auditoría'),

  define('settings', 'read', 'Ver la configuración del salón'),
  define('settings', 'update', 'Modificar la configuración del salón'),

  // --- Clientes -----------------------------------------------------------
  define('clients', 'read', 'Ver la ficha de clientes'),
  define('clients', 'create', 'Dar de alta clientes'),
  define('clients', 'update', 'Modificar la ficha de clientes'),
  define('clients', 'delete', 'Dar de baja clientes'),
  define('clients', 'restore', 'Recuperar clientes dados de baja'),
  define('clients', 'export', 'Exportar datos de clientes'),
  define('clients', 'anonymize', 'Anonimizar un cliente (derecho de supresión RGPD)'),

  // --- Profesionales ------------------------------------------------------
  define('stylists', 'read', 'Ver el equipo de profesionales'),
  define('stylists', 'create', 'Dar de alta profesionales'),
  define('stylists', 'update', 'Modificar la ficha de un profesional'),
  define('stylists', 'delete', 'Dar de baja profesionales'),
  define('stylists', 'restore', 'Recuperar profesionales dados de baja'),
  define('stylists', 'manage-schedule', 'Gestionar horarios y ausencias'),

  // --- Catálogo -----------------------------------------------------------
  define('services', 'read', 'Ver el catálogo de servicios'),
  define('services', 'create', 'Crear servicios'),
  define('services', 'update', 'Modificar servicios y tarifas'),
  define('services', 'delete', 'Retirar servicios del catálogo'),
  define('services', 'restore', 'Recuperar servicios retirados'),

  define('categories', 'read', 'Ver categorías'),
  define('categories', 'create', 'Crear categorías'),
  define('categories', 'update', 'Modificar categorías'),
  define('categories', 'delete', 'Eliminar categorías'),
  define('categories', 'restore', 'Recuperar categorías eliminadas'),

  // --- Agenda -------------------------------------------------------------
  define('appointments', 'read', 'Ver la agenda completa del salón'),
  define('appointments', 'read.own', 'Ver únicamente la agenda propia'),
  define('appointments', 'create', 'Agendar citas'),
  define('appointments', 'create.own', 'Agendar citas únicamente para sí misma'),
  define('appointments', 'update', 'Modificar citas'),
  define('appointments', 'update.own', 'Modificar únicamente las citas propias'),
  define('appointments', 'cancel', 'Cancelar citas'),
  define('appointments', 'delete', 'Eliminar citas'),
  define('appointments', 'restore', 'Recuperar citas eliminadas'),

  // --- Productos e inventario ---------------------------------------------
  define('products', 'read', 'Ver el catálogo de productos'),
  define('products', 'create', 'Dar de alta productos'),
  define('products', 'update', 'Modificar productos'),
  define('products', 'delete', 'Dar de baja productos'),
  define('products', 'restore', 'Recuperar productos dados de baja'),
  define('products', 'read-cost', 'Ver costes y márgenes de producto'),

  define('inventory', 'read', 'Consultar existencias y movimientos'),
  define('inventory', 'adjust', 'Ajustar existencias por recuento o merma'),
  define('inventory', 'receive', 'Registrar entradas de mercancía'),

  // --- Proveedores y compras ----------------------------------------------
  define('suppliers', 'read', 'Ver proveedores'),
  define('suppliers', 'create', 'Dar de alta proveedores'),
  define('suppliers', 'update', 'Modificar proveedores'),
  define('suppliers', 'delete', 'Dar de baja proveedores'),
  define('suppliers', 'restore', 'Recuperar proveedores dados de baja'),

  define('purchases', 'read', 'Ver pedidos de compra'),
  define('purchases', 'create', 'Crear pedidos de compra'),
  define('purchases', 'update', 'Modificar pedidos de compra'),
  define('purchases', 'submit', 'Enviar pedidos al proveedor'),
  define('purchases', 'receive', 'Registrar la recepción de un pedido'),
  define('purchases', 'cancel', 'Anular pedidos de compra'),

  // --- Facturación y caja --------------------------------------------------
  define('invoices', 'read', 'Ver facturas'),
  define('invoices', 'create', 'Crear facturas'),
  define('invoices', 'update', 'Modificar facturas en borrador'),
  define('invoices', 'issue', 'Emitir facturas'),
  define('invoices', 'void', 'Anular facturas emitidas'),

  define('payments', 'read', 'Ver cobros'),
  define('payments', 'create', 'Registrar cobros'),
  define('payments', 'refund', 'Emitir devoluciones'),

  define('cash', 'read', 'Ver sesiones de caja'),
  define('cash', 'open', 'Abrir caja'),
  define('cash', 'close', 'Cerrar y cuadrar caja'),
  define('cash', 'movement', 'Registrar entradas y salidas de efectivo'),

  // --- Informes ------------------------------------------------------------
  define('reports', 'read', 'Ver informes operativos'),
  define('reports', 'financial', 'Ver informes financieros y márgenes'),
  define('reports', 'commissions', 'Ver el informe de comisiones del equipo'),
  define('reports', 'export', 'Exportar informes'),

  // --- Metas e incentivos ---------------------------------------------------
  define('goals', 'read', 'Ver las metas de todo el equipo'),
  define('goals', 'read.own', 'Ver únicamente las metas propias'),
  define('goals', 'create', 'Definir metas de facturación'),
  define('goals', 'delete', 'Cancelar metas'),
] as const;

export const ALL_PERMISSION_CODES: readonly string[] = PERMISSION_DEFINITIONS.map((p) => p.code);

/**
 * Acceso tipado a los códigos de permiso.
 *
 * `PERMISSIONS.appointments.cancel` en lugar de `'appointments.cancel'`: un renombrado
 * rompe la compilación en vez de cerrar un endpoint en producción.
 */
export const PERMISSIONS = {
  users: {
    read: 'users.read',
    create: 'users.create',
    update: 'users.update',
    delete: 'users.delete',
    restore: 'users.restore',
    assignRoles: 'users.assign-roles',
  },
  roles: {
    read: 'roles.read',
    create: 'roles.create',
    update: 'roles.update',
    delete: 'roles.delete',
  },
  audit: { read: 'audit.read' },
  settings: { read: 'settings.read', update: 'settings.update' },
  clients: {
    read: 'clients.read',
    create: 'clients.create',
    update: 'clients.update',
    delete: 'clients.delete',
    restore: 'clients.restore',
    export: 'clients.export',
    anonymize: 'clients.anonymize',
  },
  stylists: {
    read: 'stylists.read',
    create: 'stylists.create',
    update: 'stylists.update',
    delete: 'stylists.delete',
    restore: 'stylists.restore',
    manageSchedule: 'stylists.manage-schedule',
  },
  services: {
    read: 'services.read',
    create: 'services.create',
    update: 'services.update',
    delete: 'services.delete',
    restore: 'services.restore',
  },
  categories: {
    read: 'categories.read',
    create: 'categories.create',
    update: 'categories.update',
    delete: 'categories.delete',
    restore: 'categories.restore',
  },
  appointments: {
    read: 'appointments.read',
    readOwn: 'appointments.read.own',
    create: 'appointments.create',
    createOwn: 'appointments.create.own',
    update: 'appointments.update',
    updateOwn: 'appointments.update.own',
    cancel: 'appointments.cancel',
    delete: 'appointments.delete',
    restore: 'appointments.restore',
  },
  products: {
    read: 'products.read',
    create: 'products.create',
    update: 'products.update',
    delete: 'products.delete',
    restore: 'products.restore',
    readCost: 'products.read-cost',
  },
  inventory: {
    read: 'inventory.read',
    adjust: 'inventory.adjust',
    receive: 'inventory.receive',
  },
  suppliers: {
    read: 'suppliers.read',
    create: 'suppliers.create',
    update: 'suppliers.update',
    delete: 'suppliers.delete',
    restore: 'suppliers.restore',
  },
  purchases: {
    read: 'purchases.read',
    create: 'purchases.create',
    update: 'purchases.update',
    submit: 'purchases.submit',
    receive: 'purchases.receive',
    cancel: 'purchases.cancel',
  },
  invoices: {
    read: 'invoices.read',
    create: 'invoices.create',
    update: 'invoices.update',
    issue: 'invoices.issue',
    void: 'invoices.void',
  },
  payments: { read: 'payments.read', create: 'payments.create', refund: 'payments.refund' },
  cash: {
    read: 'cash.read',
    open: 'cash.open',
    close: 'cash.close',
    movement: 'cash.movement',
  },
  reports: {
    read: 'reports.read',
    financial: 'reports.financial',
    commissions: 'reports.commissions',
    export: 'reports.export',
  },
  goals: {
    read: 'goals.read',
    readOwn: 'goals.read.own',
    create: 'goals.create',
    delete: 'goals.delete',
  },
} as const;

// ---------------------------------------------------------------------------
// Roles del sistema
// ---------------------------------------------------------------------------

export const SYSTEM_ROLES = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  RECEPTIONIST: 'RECEPTIONIST',
  STYLIST: 'STYLIST',
} as const;

export type SystemRoleCode = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

interface SystemRoleDefinition {
  readonly code: SystemRoleCode;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

const withoutPlatformScope = (codes: readonly string[]) => codes;

/**
 * Composición de los roles predefinidos.
 *
 * Estos perfiles no son arbitrarios: describen cómo se reparte el trabajo en un salón
 * real. Lo interesante son las **exclusiones**, que es donde el modelo demuestra que
 * sirve para algo:
 *
 * - La recepcionista agenda, cobra y cuadra caja, pero **no ve costes ni márgenes**
 *   (`products.read-cost`, `reports.financial`). Maneja dinero a diario sin acceso a la
 *   rentabilidad del negocio, que es información de la propiedad.
 * - La estilista solo tiene los permisos `.own`: su agenda, no la de sus compañeras. En
 *   un sector con mucha rotación y clientela que se lleva quien se va, la lista completa
 *   de clientes es el activo del salón.
 * - La encargada compra y gestiona inventario, pero no puede **anular facturas emitidas**
 *   (`invoices.void`) ni tocar usuarios: son las dos palancas con las que se tapa un
 *   descuadre, y quedan en manos de la propiedad.
 */
export const SYSTEM_ROLE_DEFINITIONS: readonly SystemRoleDefinition[] = [
  {
    code: SYSTEM_ROLES.PLATFORM_ADMIN,
    name: 'Administrador de plataforma',
    description:
      'Opera la plataforma entre salones. No es un rol de negocio: se reserva al equipo ' +
      'técnico y su uso queda registrado en la auditoría.',
    // El comodín se resuelve en el guard. Enumerar los permisos aquí obligaría a
    // acordarse de añadir cada permiso nuevo también a este rol.
    permissions: ['*'],
  },
  {
    code: SYSTEM_ROLES.OWNER,
    name: 'Propietaria',
    description: 'Control total sobre su salón, incluidos usuarios, finanzas y anulaciones.',
    permissions: withoutPlatformScope(ALL_PERMISSION_CODES),
  },
  {
    code: SYSTEM_ROLES.MANAGER,
    name: 'Encargada',
    description: 'Gestión diaria completa: equipo, catálogo, compras, caja e informes operativos.',
    permissions: [
      PERMISSIONS.users.read,
      PERMISSIONS.roles.read,
      PERMISSIONS.settings.read,
      PERMISSIONS.clients.read,
      PERMISSIONS.clients.create,
      PERMISSIONS.clients.update,
      PERMISSIONS.clients.delete,
      PERMISSIONS.clients.restore,
      PERMISSIONS.stylists.read,
      PERMISSIONS.stylists.create,
      PERMISSIONS.stylists.update,
      PERMISSIONS.stylists.manageSchedule,
      PERMISSIONS.services.read,
      PERMISSIONS.services.create,
      PERMISSIONS.services.update,
      PERMISSIONS.services.delete,
      PERMISSIONS.categories.read,
      PERMISSIONS.categories.create,
      PERMISSIONS.categories.update,
      PERMISSIONS.categories.delete,
      PERMISSIONS.appointments.read,
      PERMISSIONS.appointments.create,
      PERMISSIONS.appointments.update,
      PERMISSIONS.appointments.cancel,
      PERMISSIONS.products.read,
      PERMISSIONS.products.create,
      PERMISSIONS.products.update,
      PERMISSIONS.products.delete,
      PERMISSIONS.products.readCost,
      PERMISSIONS.inventory.read,
      PERMISSIONS.inventory.adjust,
      PERMISSIONS.inventory.receive,
      PERMISSIONS.suppliers.read,
      PERMISSIONS.suppliers.create,
      PERMISSIONS.suppliers.update,
      PERMISSIONS.suppliers.delete,
      PERMISSIONS.purchases.read,
      PERMISSIONS.purchases.create,
      PERMISSIONS.purchases.update,
      PERMISSIONS.purchases.submit,
      PERMISSIONS.purchases.receive,
      PERMISSIONS.purchases.cancel,
      PERMISSIONS.invoices.read,
      PERMISSIONS.invoices.create,
      PERMISSIONS.invoices.update,
      PERMISSIONS.invoices.issue,
      PERMISSIONS.payments.read,
      PERMISSIONS.payments.create,
      PERMISSIONS.payments.refund,
      PERMISSIONS.cash.read,
      PERMISSIONS.cash.open,
      PERMISSIONS.cash.close,
      PERMISSIONS.cash.movement,
      PERMISSIONS.reports.read,
      PERMISSIONS.reports.commissions,
      PERMISSIONS.reports.export,
      PERMISSIONS.goals.read,
      PERMISSIONS.goals.create,
      PERMISSIONS.goals.delete,
    ],
  },
  {
    code: SYSTEM_ROLES.RECEPTIONIST,
    name: 'Recepción',
    description:
      'Agenda, atención al cliente y cobro en mostrador. Sin acceso a costes ni márgenes.',
    permissions: [
      PERMISSIONS.clients.read,
      PERMISSIONS.clients.create,
      PERMISSIONS.clients.update,
      PERMISSIONS.stylists.read,
      PERMISSIONS.services.read,
      PERMISSIONS.categories.read,
      PERMISSIONS.appointments.read,
      PERMISSIONS.appointments.create,
      PERMISSIONS.appointments.update,
      PERMISSIONS.appointments.cancel,
      PERMISSIONS.products.read,
      PERMISSIONS.inventory.read,
      PERMISSIONS.invoices.read,
      PERMISSIONS.invoices.create,
      PERMISSIONS.invoices.issue,
      PERMISSIONS.payments.read,
      PERMISSIONS.payments.create,
      PERMISSIONS.cash.read,
      PERMISSIONS.cash.open,
      PERMISSIONS.cash.close,
      PERMISSIONS.cash.movement,
    ],
  },
  {
    code: SYSTEM_ROLES.STYLIST,
    name: 'Profesional',
    description: 'Consulta su propia agenda y la ficha de las clientas a las que atiende.',
    permissions: [
      PERMISSIONS.appointments.readOwn,
      PERMISSIONS.appointments.createOwn,
      PERMISSIONS.appointments.updateOwn,
      PERMISSIONS.clients.read,
      PERMISSIONS.services.read,
      PERMISSIONS.products.read,
      PERMISSIONS.invoices.create,
      PERMISSIONS.payments.create,
      PERMISSIONS.goals.readOwn,
    ],
  },
] as const;
