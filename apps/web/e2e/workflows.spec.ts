import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

type PurchaseOrderTest = {
  id: string;
  number: string;
  status: string;
  total: string;
  currency: string;
  createdAt: string;
  supplier: {
    id: string;
    code: string;
    name: string;
    email: null;
    phone: null;
    paymentTermDays: number;
  };
  lines: Array<{
    id: string;
    productId: string;
    quantity: string;
    receivedQuantity: string;
    unitCost: string;
    product: { id: string; sku: string; name: string; costPrice: string; tracksBatches: boolean };
  }>;
};

const client = {
  id: '01900000-0000-7000-8000-000000000001',
  fullName: 'Ana Prueba',
  firstName: 'Ana',
  lastName: 'Prueba',
  phone: '+50255550000',
};
const stylists = [
  {
    id: '01900000-0000-7000-8000-000000000010',
    displayName: 'María',
    color: '#db2777',
    isBookable: true,
  },
  {
    id: '01900000-0000-7000-8000-000000000011',
    displayName: 'Andrea',
    color: '#7c3aed',
    isBookable: true,
  },
];
const service = {
  id: 'svc-test-corte',
  name: 'Corte',
  blockedMinutes: 45,
  price: '100.00',
  priceWithTax: '100.00',
  taxRate: 0,
  currency: 'GTQ',
  isBookable: true,
};
const appointmentStart = new Date();
appointmentStart.setHours(10, 0, 0, 0);
const appointmentEnd = new Date(appointmentStart.getTime() + 45 * 60_000);
const appointment = {
  id: '01900000-0000-7000-8000-000000000020',
  clientId: client.id,
  stylistId: stylists[0].id,
  startsAt: appointmentStart.toISOString(),
  endsAt: appointmentEnd.toISOString(),
  durationMinutes: 45,
  status: 'SCHEDULED',
  estimatedTotal: '100.00',
  currency: 'GTQ',
  services: [{ serviceId: service.id }],
};

async function authenticated(page: Page) {
  await page
    .context()
    .addCookies([{ name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
}
async function mockAgenda(page: Page, onWrite?: (url: string, body: unknown) => void) {
  await page.route('**/api/agenda**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      onWrite?.(url.toString(), request.postDataJSON());
      return route.fulfill({
        status: request.method() === 'POST' ? 201 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: appointment }),
      });
    }
    const resource = url.searchParams.get('resource');
    const data =
      resource === 'calendar'
        ? [appointment]
        : resource === 'stylists'
          ? stylists
          : resource === 'services'
            ? [service]
            : resource === 'clients'
              ? [client]
              : [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data }),
    });
  });
}

test('inicia sesión correctamente', async ({ page }) => {
  await page.route('**/api/auth/login', async (route) => {
    await page
      .context()
      .addCookies([
        { name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' },
      ]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'owner' } }),
    });
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Ingresar' })).toBeEnabled();
  await page.getByLabel('Correo electrónico').fill('propietaria@bella-vista.es');
  await page.locator('#password').fill('SalonDemo2026');
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL('/');
});

test('reserva una cita desde el acceso rápido del Home', async ({ page }) => {
  await authenticated(page);
  await mockAgenda(page);
  await page.route('**/api/reports**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          sales: '0.00',
          tickets: 0,
          averageTicket: '0.00',
          retentionRate: 0,
          occupancyRate: 0,
          completedAppointments: 0,
          cancelledAppointments: 0,
          topProducts: [],
          topStylists: [],
          dailySales: [],
          upcoming: [],
          lowStockCount: 0,
          cash: { isOpen: false, openedAt: null, expected: '0.00' },
          currency: 'GTQ',
          period: { from: '', to: '' },
        },
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: 'Nueva cita' }).click();
  await expect(page.getByRole('heading', { name: 'Nueva cita' })).toBeVisible();
  await page.getByLabel('Clienta').selectOption(client.id);
  await page.getByLabel('Estilista').selectOption(stylists[0].id);
  await page.getByLabel('Fecha y hora').fill('2026-09-03T10:00');
  await page.locator('input[name="serviceIds"]').check();
  await page.getByRole('button', { name: 'Reservar cita' }).click();
  await expect(page.getByRole('heading', { name: 'Nueva cita' })).not.toBeVisible();
});

test('cancela una cita y cambia de estilista', async ({ page }) => {
  const writes: { url: string; body: unknown }[] = [];
  await authenticated(page);
  await mockAgenda(page, (url, body) => writes.push({ url, body }));
  await page.goto('/agenda');
  // La tarjeta de la cita, no el título del diálogo, que ahora también lleva el nombre.
  const cita = page.getByRole('button', { name: /Ana Prueba/ });
  await cita.click();
  await page.getByLabel('Cambiar estilista').selectOption(stylists[1].id);
  await page.getByRole('button', { name: 'Guardar estilista' }).click();
  await expect
    .poll(() => writes.some((x) => (x.body as { stylistId?: string }).stylistId === stylists[1].id))
    .toBeTruthy();
  await cita.click();
  await page.getByLabel('Motivo de cancelación').fill('Solicitud de la clienta');
  await page.getByRole('button', { name: 'Cancelar cita' }).click();
  await expect.poll(() => writes.some((x) => x.url.includes('action=cancel'))).toBeTruthy();
});

test('vende un producto en quetzales', async ({ page }) => {
  await authenticated(page);
  let sale: { payments: Array<{ method: string; amount: number }> } | null = null;
  const products = [
    {
      id: 'product-1',
      name: 'Champú',
      price: '10.04',
      taxRate: 12,
      stockOnHand: '10.000',
      trackStock: true,
    },
    {
      id: 'product-2',
      name: 'Tinte',
      price: '10.04',
      taxRate: 12,
      stockOnHand: '10.000',
      trackStock: true,
    },
  ];
  // La búsqueda se hace en el servidor: el doble filtra por nombre como lo haría la API.
  await page.route('**/api/inventory?resource=products**', (route) => {
    const search = new URL(route.request().url()).searchParams.get('search') ?? '';
    return route.fulfill({
      json: { data: products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) },
    });
  });
  await page.route('**/api/agenda?resource=**', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/stylists/me', (route) => route.fulfill({ json: { data: null } }));
  await page.route('**/api/service-tickets?**', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/cash?resource=current', (route) =>
    route.fulfill({ json: { data: { id: 'cash-1', status: 'OPEN' } } }),
  );
  await page.route('**/api/sales', (route) => {
    sale = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: { data: { number: 'F-2026-000001', total: '22.48' } },
    });
  });
  await page.goto('/ventas');
  const search = page.getByRole('combobox', { name: 'Buscar servicio o producto' });
  await search.fill('Champú');
  await search.press('Enter');
  await search.fill('Tinte');
  await search.press('Enter');
  await expect(page.getByRole('button', { name: /Cobrar Q\s*22\.48/ })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByLabel('Efectivo recibido').fill('50');
  await expect(page.getByText(/Q\s*27\.52/)).toBeVisible();
  await page.getByLabel('Efectivo recibido').press('Enter');
  await expect(page.getByText('Venta F-2026-000001 completada')).toBeVisible();
  expect(sale!.payments).toEqual([{ method: 'CASH', amount: 22.48 }]);
});

test('abre y cierra la caja', async ({ page }) => {
  await authenticated(page);
  let current: Record<string, unknown> | null = null;
  const session = {
    id: 'cash-1',
    status: 'OPEN',
    openedAt: new Date().toISOString(),
    closedAt: null,
    openingFloat: '100.00',
    cashSales: '0.00',
    expectedAmount: '100.00',
    countedAmount: null,
    difference: null,
    currency: 'GTQ',
    movements: [],
  };
  await page.route('**/api/cash**', async (route) => {
    const url = new URL(route.request().url());
    const resource = url.searchParams.get('resource');
    if (route.request().method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: resource === 'history' ? [] : current }),
      });
    current = resource === 'close' ? null : session;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data:
          resource === 'close'
            ? { ...session, status: 'CLOSED', countedAmount: '100.00', difference: '0.00' }
            : session,
      }),
    });
  });
  // Caja también lista los servicios por cobrar y los usuarios de la auditoría. Sin dobles,
  // esas llamadas salen a la API real si hay una en marcha, y su 401 cierra la sesión.
  await page.route('**/api/service-tickets?**', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/admin?resource=users**', (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  await page.goto('/caja');
  await page.getByRole('button', { name: 'Abrir caja' }).click();
  await page.getByLabel('Monto').fill('100');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Abierta', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar caja' }).click();
  await page.getByLabel('Efectivo contado').fill('100');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('La caja está cerrada')).toBeVisible();
});

test('solicita y completa la recuperación de contraseña', async ({ page }) => {
  await page.route('**/api/auth/forgot-password', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          message: 'Si el correo existe, recibirás instrucciones.',
          resetPath: '/reset-password?token=e2e-reset-token',
        },
      }),
    }),
  );
  await page.route('**/api/auth/reset-password', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );

  await page.goto('/forgot-password');
  await page.getByLabel('Correo electrónico').fill('propietaria@bella-vista.es');
  await page.getByRole('button', { name: 'Enviar instrucciones' }).click();
  await expect(page).toHaveURL(/\/reset-password\?token=e2e-reset-token/);
  await expect(page.getByRole('button', { name: 'Guardar contraseña' })).toBeEnabled();
  await page.getByLabel('Contraseña nueva').fill('NuevaClave2026');
  await page.getByLabel('Confirmar contraseña').fill('NuevaClave2026');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByText('Contraseña actualizada.')).toBeVisible();
});

test('crea proveedor, orden de compra y recibe mercancía', async ({ page }) => {
  await authenticated(page);
  const supplier = {
    id: 'supplier-e2e',
    code: 'PROV-E2E',
    name: 'Proveedor E2E',
    email: null,
    phone: null,
    paymentTermDays: 30,
  };
  const product = {
    id: 'product-e2e',
    sku: 'SKU-E2E',
    name: 'Tratamiento E2E',
    costPrice: '25.00',
    tracksBatches: false,
  };
  let suppliers: (typeof supplier)[] = [];
  let orders: PurchaseOrderTest[] = [];
  await page.route('**/api/purchases**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.searchParams.get('resource');
    const action = url.searchParams.get('action');
    if (request.method() === 'GET') {
      const data =
        resource === 'suppliers' ? suppliers : resource === 'products' ? [product] : orders;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data }),
      });
    }
    if (resource === 'supplier') {
      suppliers = [supplier];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: supplier }),
      });
    }
    if (resource === 'order') {
      orders = [
        {
          id: 'order-e2e',
          number: 'OC-2026-000099',
          status: 'DRAFT',
          total: '56.00',
          currency: 'GTQ',
          createdAt: new Date().toISOString(),
          supplier,
          lines: [
            {
              id: 'line-e2e',
              productId: product.id,
              quantity: '2',
              receivedQuantity: '0',
              unitCost: '25.00',
              product,
            },
          ],
        },
      ];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: orders[0] }),
      });
    }
    if (action === 'submit') orders = [{ ...orders[0], status: 'SUBMITTED' }];
    if (action === 'receive')
      orders = [
        {
          ...orders[0],
          status: 'RECEIVED',
          lines: [{ ...orders[0].lines[0], receivedQuantity: '2' }],
        },
      ];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: orders[0] }),
    });
  });

  await page.goto('/compras');
  await page.getByRole('button', { name: /Proveedor$/ }).click();
  await page.getByLabel('Código').fill('PROV-E2E');
  await page.getByLabel('Nombre').fill('Proveedor E2E');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: /Orden$/ }).click();
  await page.getByLabel('Proveedor').selectOption(supplier.id);
  await page.getByLabel('Producto').selectOption(product.id);
  await page.getByLabel('Cantidad').fill('2');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('OC-2026-000099')).toBeVisible();
  await page.getByRole('button', { name: 'Enviar' }).click();
  await page.getByRole('button', { name: 'Recibir' }).click();
  await page.getByRole('button', { name: 'Confirmar recepción' }).click();
  await expect(page.getByText('RECEIVED')).toBeVisible();
});

test('administra usuarios y roles del equipo', async ({ page }) => {
  await authenticated(page);
  const ownerRole = {
    id: 'role-owner',
    code: 'OWNER',
    name: 'Propietaria',
    description: 'Control total',
    isSystem: true,
    permissions: ['users.read'],
    userCount: 1,
  };
  const receptionistRole = {
    id: 'role-reception',
    code: 'RECEPTIONIST',
    name: 'Recepción',
    description: 'Agenda y caja',
    isSystem: true,
    permissions: ['users.read'],
    userCount: 0,
  };
  const permissions = [
    { code: 'users.read', resource: 'users', action: 'read', description: 'Consultar usuarios' },
  ];
  let users = [
    {
      id: 'user-owner',
      email: 'owner@beautyos.gt',
      fullName: 'Ana Propietaria',
      status: 'ACTIVE',
      roles: [{ id: ownerRole.id, code: ownerRole.code }],
      deletedAt: null as string | null,
    },
  ];
  const roles = [ownerRole, receptionistRole];
  let createdPayload: unknown;
  await page.route('**/api/admin**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.searchParams.get('resource');
    if (request.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: resource === 'users' ? users : resource === 'roles' ? roles : permissions,
        }),
      });
    if (request.method() === 'POST' && resource === 'users') {
      createdPayload = request.postDataJSON();
      users = [
        ...users,
        {
          id: 'user-new',
          email: 'maria@beautyos.gt',
          fullName: 'María López',
          status: 'ACTIVE',
          roles: [{ id: receptionistRole.id, code: receptionistRole.code }],
          deletedAt: null,
        },
      ];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: users[1] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: users[0] }),
    });
  });
  await page.goto('/configuracion');
  await expect(page.getByRole('heading', { name: 'Equipo y permisos' })).toBeVisible();
  const createUser = page.getByRole('button', { name: 'Nuevo usuario' });
  await expect(createUser).toBeEnabled();
  await createUser.click();
  await page.getByLabel('Nombre').fill('María');
  await page.getByLabel('Apellido').fill('López');
  await page.getByLabel('Correo').fill('maria@beautyos.gt');
  await page.getByLabel('Contraseña temporal').fill('Temporal2026A');
  await page
    .getByRole('dialog', { name: 'Nuevo usuario' })
    .locator('select[name="roleIds"]')
    .selectOption([receptionistRole.id]);
  await page.getByRole('button', { name: 'Crear usuario' }).click();
  await expect(page.getByText('María López')).toBeVisible();
  expect((createdPayload as { roleIds: string[] }).roleIds).toEqual([receptionistRole.id]);
});
