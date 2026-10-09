import { expect, owner, test } from './fixtures';
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
  // La API resuelve el nombre: la agenda ya no descarga todas las clientas.
  clientName: client.fullName,
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
    // Jornada de 9 a 19 para cada profesional, el día que se pida.
    const from = url.searchParams.get('from') ?? '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date().toLocaleDateString('en-CA');
    const shifts = stylists.map((stylist) => ({
      stylistId: stylist.id,
      name: stylist.displayName,
      color: stylist.color,
      isBookable: true,
      serviceIds: [],
      days: [
        {
          date: day,
          intervals: [
            {
              startsAt: new Date(`${day}T09:00:00`).toISOString(),
              endsAt: new Date(`${day}T19:00:00`).toISOString(),
            },
          ],
        },
      ],
      blocks: [],
    }));
    const slotStart = new Date(Date.now() + 86_400_000);
    slotStart.setHours(11, 0, 0, 0);
    const data =
      resource === 'calendar'
        ? [appointment]
        : resource === 'stylists'
          ? stylists
          : resource === 'services'
            ? [service]
            : resource === 'clients'
              ? [client]
              : resource === 'shifts'
                ? shifts
                : resource === 'availability'
                  ? [
                      {
                        startsAt: slotStart.toISOString(),
                        endsAt: new Date(slotStart.getTime() + 45 * 60_000).toISOString(),
                        durationMinutes: 45,
                        stylistId: stylists[0].id,
                      },
                    ]
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
  const writes: { url: string; body: unknown }[] = [];
  await mockAgenda(page, (url, body) => writes.push({ url, body }));
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
  const wizard = page.getByRole('dialog', { name: 'Nueva cita' });
  const next = wizard.getByRole('button', { name: 'Siguiente' });
  // 1. La clienta se busca en el servidor, como en el punto de venta; elegirla avanza sola.
  await expect(next).toBeDisabled();
  await wizard.getByRole('combobox', { name: 'Clienta de la cita' }).click();
  await wizard.getByRole('option', { name: /Ana Prueba/ }).dispatchEvent('mousedown');
  // 2. Servicios.
  await wizard.getByRole('button', { name: /Corte/ }).click();
  await expect(wizard).toContainText('45 min');
  await next.click();
  // 3. Profesional: cualquiera que haga los servicios.
  await wizard.getByRole('button', { name: /Cualquiera disponible/ }).click();
  // 4. Hora: solo se ofrecen las libres. Mañana, a las 11:00.
  await wizard.getByRole('option').nth(1).click();
  await wizard.getByRole('button', { name: /11:00/ }).click();
  await next.click();
  // 5. Confirmar.
  await expect(wizard.getByText('Ana Prueba')).toBeVisible();
  await wizard.getByLabel(/Nota para el equipo/).fill('Prefiere sin secador');
  await wizard.getByRole('button', { name: 'Reservar cita' }).click();
  await expect(page.getByRole('heading', { name: 'Nueva cita' })).not.toBeVisible();
  expect(writes.find((x) => x.url.endsWith('/api/agenda'))?.body).toMatchObject({
    clientId: client.id,
    stylistId: stylists[0].id,
    serviceIds: [service.id],
    source: 'PHONE',
    internalNotes: 'Prefiere sin secador',
  });
});

test.describe('agendar desde el teléfono', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('con un menú largo los botones del asistente siguen a la vista', async ({ page }) => {
    await authenticated(page);
    await mockAgenda(page);
    const menu = Array.from({ length: 30 }, (_, index) => ({
      ...service,
      id: `svc-${index}`,
      name: `Servicio ${index + 1}`,
    }));
    await page.route('**/api/agenda?resource=services**', (route) =>
      route.fulfill({ json: { data: menu } }),
    );
    await page.goto('/agenda?new=1');
    const wizard = page.getByRole('dialog', { name: 'Nueva cita' });
    await wizard.getByRole('combobox', { name: 'Clienta de la cita' }).click();
    await wizard.getByRole('option', { name: /Ana Prueba/ }).dispatchEvent('mousedown');

    // El último servicio está al fondo de la lista; el botón no se va con él.
    await wizard.getByRole('button', { name: /Servicio 30/ }).click();
    await expect(wizard.getByRole('button', { name: 'Siguiente' })).toBeInViewport();
    // Y el buscador encuentra sin recorrer la lista, aunque se escriba sin mayúsculas.
    await wizard.getByLabel('Buscar servicio').fill('servicio 7');
    await expect(wizard.getByRole('button', { name: /^Servicio \d+/ })).toHaveCount(1);
  });
});

test('cancela una cita y cambia de estilista', async ({ page }) => {
  const writes: { url: string; body: unknown }[] = [];
  await authenticated(page);
  await mockAgenda(page, (url, body) => writes.push({ url, body }));
  await page.goto('/agenda');
  await page.getByRole('tab', { name: 'Día' }).click();
  // El bloque de la cita en la parrilla, no el título de la ficha, que también lleva el nombre.
  const cita = page.getByRole('button', { name: /Ana Prueba/ }).first();
  await cita.click();
  const sheet = page.getByRole('dialog', { name: 'Ana Prueba' });
  // Mover a otra profesional: se elige con quién y una hora libre de su agenda.
  await sheet.getByRole('button', { name: 'Mover a otra hora o profesional' }).click();
  await sheet.getByRole('button', { name: 'Andrea' }).click();
  await sheet.getByRole('option').nth(1).click();
  await sheet.getByRole('button', { name: /11:00/ }).click();
  await sheet.getByRole('button', { name: 'Mover aquí' }).click();
  await expect.poll(() => writes.some((x) => x.url.includes('action=reschedule'))).toBeTruthy();

  await cita.click();
  // Cancelar es irreversible: primero pide el motivo y no envía nada todavía.
  await sheet.getByRole('button', { name: 'Cancelar cita' }).click();
  await expect(sheet.getByText('¿Por qué se cancela?')).toBeVisible();
  expect(writes.some((x) => x.url.includes('action=cancel'))).toBe(false);
  await sheet.getByRole('button', { name: 'La clienta se enfermó' }).click();
  await sheet.getByRole('button', { name: 'Cancelar cita' }).last().click();
  await expect
    .poll(() =>
      writes.some(
        (x) =>
          x.url.includes('action=cancel') &&
          (x.body as { reason?: string }).reason === 'La clienta se enfermó',
      ),
    )
    .toBeTruthy();
});

test('mueve una cita a otra hora con los huecos libres de la profesional', async ({ page }) => {
  const writes: { url: string; body: unknown }[] = [];
  await authenticated(page);
  await mockAgenda(page, (url, body) => writes.push({ url, body }));
  const slot = new Date(appointmentStart.getTime() + 4 * 60 * 60_000);
  // La ruta más reciente gana: solo cambia la respuesta de los huecos.
  await page.route('**/api/agenda?resource=availability**', (route) =>
    route.fulfill({
      json: {
        data: [{ startsAt: slot.toISOString(), endsAt: slot.toISOString(), durationMinutes: 45 }],
      },
    }),
  );
  await page.goto('/agenda');
  await page
    .getByRole('button', { name: /Ana Prueba/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Ana Prueba' });
  const hora = slot.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

  // Solo se ofrecen las horas que la API da por libres para esta profesional.
  await sheet.getByRole('button', { name: 'Mover a otra hora o profesional' }).click();
  await sheet.getByRole('button', { name: hora }).click();
  await sheet.getByRole('button', { name: 'Mover aquí' }).click();

  await expect
    .poll(() => writes.find((x) => x.url.includes('action=reschedule'))?.body)
    .toEqual({ startsAt: slot.toISOString() });
});

test('la agenda muestra el estado y deja confirmar, cerrar o marcar que no vino', async ({
  page,
}) => {
  // Las 12:00 de hoy: la cita de las 10:00 ya pasó, así que «No vino» está disponible.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  await page.clock.setFixedTime(noon);
  const writes: { url: string; body: unknown }[] = [];
  await authenticated(page);
  await mockAgenda(page, (url, body) => writes.push({ url, body }));
  await page.goto('/agenda');
  const cita = page.getByRole('button', { name: /Ana Prueba/ }).first();
  const acciones = page.getByRole('dialog', { name: 'Ana Prueba' });

  await cita.click();
  await expect(acciones).toContainText('Agendada');
  await acciones.getByRole('button', { name: 'Confirmar' }).click();
  await expect.poll(() => writes.some((x) => x.url.includes('action=confirm'))).toBe(true);

  await cita.click();
  await acciones.getByRole('button', { name: 'No vino' }).click();
  await expect.poll(() => writes.some((x) => x.url.includes('action=no-show'))).toBe(true);

  await cita.click();
  await acciones.getByRole('button', { name: 'Marcar como realizada' }).click();
  await expect.poll(() => writes.some((x) => x.url.includes('action=complete'))).toBe(true);
});

test('vende un producto en quetzales', async ({ page }) => {
  await authenticated(page);
  let sale: { payments: Array<{ method: string; amount: number }> } | null = null;
  const products = [
    {
      id: 'product-1',
      name: 'Champú',
      price: '11.24',
      taxRate: 12,
      stockOnHand: '10.000',
      trackStock: true,
    },
    {
      id: 'product-2',
      name: 'Tinte',
      price: '11.24',
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

test('pide una contraseña nueva a la propietaria', async ({ page }) => {
  let requested: unknown;
  await page.route('**/api/auth/forgot-password', (route) => {
    requested = route.request().postDataJSON();
    // Aunque la API devolviera un enlace, la página no debe seguirlo: sería entregar la
    // cuenta a quien escriba el correo.
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { message: 'Aviso registrado.', resetPath: '/reset-password?token=no-seguir' },
      }),
    });
  });

  await page.goto('/forgot-password');
  await page.getByLabel('Correo electrónico').fill('estilista@bella-vista.es');
  await page.getByRole('button', { name: 'Pedir contraseña nueva' }).click();
  await expect(page.getByText(/la propietaria verá tu solicitud/)).toBeVisible();
  expect(requested).toEqual({ email: 'estilista@bella-vista.es' });
  await expect(page).toHaveURL(/\/forgot-password$/);
});

test('completa la recuperación con el enlace del correo', async ({ page }) => {
  await page.route('**/api/auth/reset-password', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );

  await page.goto('/reset-password?token=e2e-reset-token');
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
  await expect(page.getByText('Recibida', { exact: true })).toBeVisible();
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
          data:
            resource === 'users'
              ? users
              : resource === 'roles'
                ? roles
                : resource === 'permissions'
                  ? permissions
                  : [],
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
    .getByRole('checkbox', { name: receptionistRole.name })
    .check();
  await page.getByRole('button', { name: 'Crear usuario' }).click();
  await expect(page.getByText('María López')).toBeVisible();
  expect((createdPayload as { roleIds: string[] }).roleIds).toEqual([receptionistRole.id]);
});

test('la propietaria atiende una solicitud de contraseña desde Equipo', async ({ page }) => {
  await authenticated(page);
  let requests = [
    {
      id: 'request-1',
      userId: 'user-stylist',
      email: 'sara@beautyos.gt',
      fullName: 'Sara Molina',
      requestedAt: '2026-10-06T15:00:00.000Z',
    },
  ];
  let assigned: { id: string | null; body: unknown } | undefined;
  await page.route('**/api/admin**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.searchParams.get('action') === 'password') {
      assigned = { id: url.searchParams.get('id'), body: request.postDataJSON() };
      requests = [];
      return route.fulfill({ status: 204, body: '' });
    }
    const resource = url.searchParams.get('resource');
    return route.fulfill({
      json: { data: resource === 'password-reset-requests' ? requests : [] },
    });
  });

  await page.goto('/configuracion');
  // El aviso llega también al menú, para verlo desde cualquier pantalla. En el iPad, Equipo
  // va en «Más», y el botón suma los avisos de lo que guarda.
  await expect(
    page
      .getByLabel('1 solicitudes de contraseña')
      .or(page.getByLabel('1 avisos en otras secciones'))
      .filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText('1 persona no puede entrar')).toBeVisible();
  await page.getByRole('button', { name: 'Asignar contraseña' }).click();
  const dialog = page.getByRole('dialog', { name: 'Contraseña de Sara Molina' });
  await dialog.getByRole('button', { name: 'Generar una' }).click();
  const generated = await dialog.getByLabel('Contraseña nueva').inputValue();
  expect(generated).toMatch(/^[A-Z][a-z]{3,}[A-Z][a-z]{3,}\d{4}$/);
  await dialog.getByRole('button', { name: 'Guardar contraseña' }).click();

  await expect(dialog.getByText(generated)).toBeVisible();
  expect(assigned).toEqual({ id: 'user-stylist', body: { newPassword: generated } });
  await dialog.getByRole('button', { name: 'Hecho' }).click();
  await expect(page.getByText('1 persona no puede entrar')).toBeHidden();
});

test('la dueña crea un servicio escribiendo lo que cobra', async ({ page }) => {
  await authenticated(page);
  const services: Array<Record<string, unknown>> = [];
  let created: Record<string, unknown> | undefined;
  await page.route('**/api/agenda?resource=**', (route) =>
    route.fulfill({ json: { data: route.request().url().includes('services') ? services : [] } }),
  );
  await page.route('**/api/services', (route) => {
    created = route.request().postDataJSON() as Record<string, unknown>;
    services.push({
      id: 'service-new',
      name: created.name,
      commissionRate: null,
      durationMinutes: created.durationMinutes,
      bufferMinutes: created.bufferMinutes,
      priceWithTax: '100.00',
      taxRate: 12,
    });
    return route.fulfill({ status: 201, json: { data: services[0] } });
  });

  await page.goto('/comisiones');
  await page.getByLabel('Nombre del servicio').fill('Corte de señora');
  await page.getByLabel('Precio que paga la clienta (Q)').fill('100');
  await page.getByLabel('Duración (minutos)').fill('45');
  await page.getByLabel('Limpieza después (minutos, opcional)').fill('10');

  const summary = page.getByRole('status', { name: 'Resumen del servicio' });
  await expect(summary).toContainText(/La clienta paga Q\s?100\.00/);
  await expect(summary).toContainText(/Q\s?10\.71 de IVA/);
  await expect(summary).toContainText('55 min');
  await page.getByRole('button', { name: 'Crear servicio' }).click();

  await expect(page.getByText('«Corte de señora» quedó creado')).toBeVisible();
  // Se guarda lo que cobra, con el IVA dentro (ADR-0021); el código lo pone la API.
  expect(created).toEqual({
    name: 'Corte de señora',
    durationMinutes: 45,
    price: '100.00',
    taxRate: 12,
    bufferMinutes: 10,
    commissionRate: null,
  });
  await expect(page.getByRole('listitem').filter({ hasText: 'Corte de señora' })).toContainText(
    /Q\s?100\.00 · 45 min \+ 10 de limpieza/,
  );
  // Listo para el siguiente: el nombre vuelve a estar vacío y con el foco.
  await expect(page.getByLabel('Nombre del servicio')).toBeFocused();
});

test('la encargada edita y elimina un servicio', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        data: {
          ...owner,
          id: 'manager',
          roles: ['MANAGER'],
          permissions: [
            'services.read',
            'services.create',
            'services.update',
            'services.delete',
            'stylists.read',
            'stylists.update',
          ],
        },
      },
    }),
  );
  let services = [
    {
      id: 'svc-1',
      name: 'Corte de señora',
      durationMinutes: 45,
      bufferMinutes: 10,
      priceWithTax: '100.00',
      taxRate: 12,
      commissionRate: null as number | null,
    },
  ];
  const patches: unknown[] = [];
  let deleted = false;
  await page.route('**/api/agenda?resource=**', (route) =>
    route.fulfill({ json: { data: route.request().url().includes('services') ? services : [] } }),
  );
  await page.route('**/api/services/svc-1', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      services = [{ ...services[0]!, ...body, priceWithTax: '150.00' }];
      return route.fulfill({ json: { data: services[0] } });
    }
    deleted = true;
    services = [];
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto('/comisiones');
  await page.getByRole('button', { name: 'Editar Corte de señora' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Corte de señora' });
  // Abre con lo que la dueña reconoce: el precio que paga la clienta, no el de sin IVA.
  await expect(dialog.getByLabel('Precio que paga la clienta (Q)')).toHaveValue('100');
  await dialog.getByLabel('Nombre del servicio').fill('Corte y peinado');
  await dialog.getByLabel('Precio que paga la clienta (Q)').fill('150');
  await dialog.getByLabel('Duración (minutos)').fill('60');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();

  await expect(page.getByText('«Corte y peinado» se actualizó.')).toBeVisible();
  expect(patches[0]).toEqual({
    name: 'Corte y peinado',
    durationMinutes: 60,
    bufferMinutes: 10,
    commissionRate: null,
    price: '150.00',
  });

  // Cambiar solo la comisión no manda el precio: no hay cambio de precio que auditar.
  await page.getByRole('button', { name: 'Editar Corte y peinado' }).click();
  const again = page.getByRole('dialog', { name: 'Editar Corte y peinado' });
  await again.getByLabel('Comisión especial (%, opcional)').fill('30');
  await again.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(again).toBeHidden();
  expect(patches[1]).toEqual({
    name: 'Corte y peinado',
    durationMinutes: 60,
    bufferMinutes: 10,
    commissionRate: 30,
  });

  page.once('dialog', (confirm) => void confirm.accept());
  await page.getByRole('button', { name: 'Eliminar Corte y peinado' }).click();
  await expect(page.getByText('«Corte y peinado» se eliminó.')).toBeVisible();
  expect(deleted).toBe(true);
});

test('la dueña da de alta un producto con lo que cobra y lo corrige después', async ({ page }) => {
  await authenticated(page);
  const product = {
    id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
    sku: 'SH-ARG-500',
    name: 'Champú de argán',
    brand: null as string | null,
    price: '100.00',
    taxRate: '12.00',
    currency: 'GTQ',
    stockOnHand: '0.000',
    reorderPoint: '2.000',
    reorderQuantity: '6.000',
    stockStatus: 'OUT',
  };
  let products: (typeof product)[] = [];
  const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/inventory?resource=products**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { data: products } });
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ method: request.method(), url: request.url(), body });
    // La API guarda lo que manda la pantalla: el precio con el IVA dentro.
    products = [{ ...product, name: String(body.name), price: String(body.price ?? '100.00') }];
    return route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: { data: {} } });
  });

  await page.goto('/inventario');
  await page.getByRole('button', { name: 'Producto', exact: true }).click();
  const alta = page.getByRole('dialog', { name: 'Nuevo producto' });
  await alta.getByLabel('SKU').fill('sh arg 500');
  await alta.getByLabel('Nombre').fill('Champú de argán');
  await alta.getByLabel('Precio de venta (Q)').fill('100');
  await expect(alta.getByRole('status')).toContainText(/Q\s?100\.00.*Q\s?10\.71 de IVA/);
  await alta.getByLabel('Existencia mínima').fill('2');
  await alta.getByLabel('Cantidad a reponer').fill('6');
  await alta.getByRole('button', { name: 'Guardar' }).click();
  await expect(alta).toBeHidden();

  expect(writes[0]).toMatchObject({
    method: 'POST',
    body: {
      sku: 'SH-ARG-500',
      name: 'Champú de argán',
      price: 100,
      taxRate: 12,
      reorderPoint: 2,
      reorderQuantity: 6,
    },
  });
  // En inventario se ve lo mismo que se escribió y lo mismo que se cobrará en caja.
  await expect(page.getByText(/Q\s?100\.00/)).toBeVisible();

  await page.getByRole('button', { name: 'Editar Champú de argán' }).click();
  const edicion = page.getByRole('dialog', { name: 'Editar Champú de argán' });
  await expect(edicion.getByLabel('Precio de venta (Q)')).toHaveValue('100');
  await edicion.getByLabel('Precio de venta (Q)').fill('120');
  await edicion.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(edicion).toBeHidden();

  expect(writes[1].method).toBe('PATCH');
  expect(writes[1].url).toContain(`id=${product.id}`);
  expect(writes[1].body).toEqual({
    name: 'Champú de argán',
    brand: '',
    reorderPoint: 2,
    reorderQuantity: 6,
    price: 120,
  });

  // Corregir solo el nombre no manda el precio: no hay cambio de precio que auditar.
  await page.getByRole('button', { name: 'Editar Champú de argán' }).click();
  const otra = page.getByRole('dialog', { name: 'Editar Champú de argán' });
  await otra.getByLabel('Nombre').fill('Champú de argán 500 ml');
  await otra.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(otra).toBeHidden();
  expect(writes[2].body).not.toHaveProperty('price');
});
