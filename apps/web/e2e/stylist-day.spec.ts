import type { Page } from '@playwright/test';
import { expect, owner, test } from './fixtures';

const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString();

const appointment = (
  id: string,
  clientName: string,
  start: number,
  end: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  clientId: `client-${id}`,
  clientName,
  stylistId: 'sara',
  startsAt: minutes(start),
  endsAt: minutes(end),
  durationMinutes: end - start,
  status: 'SCHEDULED',
  estimatedTotal: '28.00',
  currency: 'GTQ',
  services: [{ serviceId: 's1' }],
  ...overrides,
});

const services = [
  {
    id: 's1',
    name: 'Corte de dama',
    durationMinutes: 45,
    price: '25.00',
    priceWithTax: '28.00',
    currency: 'GTQ',
  },
  {
    id: 's2',
    name: 'Tinte completo',
    durationMinutes: 120,
    price: '120.00',
    priceWithTax: '134.40',
    currency: 'GTQ',
  },
];

const STYLIST = [
  'appointments.read.own',
  'appointments.create.own',
  'appointments.update.own',
  'clients.read',
  'services.read',
  'products.read',
  'goals.read.own',
  'service-tickets.read.own',
  'service-tickets.create.own',
  'service-tickets.cancel.own',
];

type TicketBody = {
  serviceIds: string[];
  appointmentId?: string;
  clientId?: string;
  clientName?: string;
  stylistId?: string;
};

/** Dobles de la API para quien atiende o registra: cuenta, agenda de hoy, servicios y comandas. */
async function mockDay(
  page: Page,
  options: {
    permissions: string[];
    role: string;
    appointments: ReturnType<typeof appointment>[];
    isStylist?: boolean;
  },
) {
  await page
    .context()
    .addCookies([{ name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      json: {
        data: {
          ...owner,
          firstName: 'Sara',
          lastName: 'Molina',
          roles: [options.role],
          permissions: options.permissions,
        },
      },
    }),
  );
  await page.route('**/api/stylists/me', (r) =>
    r.fulfill({
      json: {
        data: options.isStylist === false ? null : { id: 'sara', displayName: 'Sara Molina' },
      },
    }),
  );
  // Primero la lista: Playwright consulta las rutas de la última a la primera, y este patrón
  // también casaría con `/assignable`.
  await page.route('**/api/service-tickets?**', (r) => r.fulfill({ json: { data: [] } }));
  const assignable: string[] = [];
  await page.route('**/api/agenda?resource=**', (route) => {
    const resource = new URL(route.request().url()).searchParams.get('resource');
    const data =
      resource === 'calendar'
        ? options.appointments
        : resource === 'clients'
          ? [{ id: 'c2', fullName: 'Ana López', phone: '5555 0002', email: null }]
          : resource === 'stylists'
            ? [{ id: 'sara', displayName: 'Sara Molina', color: '#db2777', isBookable: true }]
            : resource === 'services'
              ? services.map((s) => ({ ...s, blockedMinutes: 45, isBookable: true }))
              : [];
    return route.fulfill({ json: { data } });
  });
  await page.route('**/api/service-tickets/assignable**', (route) => {
    assignable.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { data: services } });
  });
  const sent: TicketBody[] = [];
  await page.route('**/api/service-tickets', (route) => {
    sent.push(route.request().postDataJSON() as TicketBody);
    return route.fulfill({
      status: 201,
      json: {
        data: {
          id: 't1',
          status: 'PENDING',
          clientName: 'Rosa Méndez',
          total: '162.40',
          lines: [],
        },
      },
    });
  });
  return { sent, assignable };
}

test.describe('la estilista en su celular', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const asStylist = (page: Page, appointments: ReturnType<typeof appointment>[]) =>
    mockDay(page, { permissions: STYLIST, role: 'STYLIST', appointments });

  test('entra directo a Mi día y no tiene Ventas', async ({ page }) => {
    await asStylist(page, []);
    await page.goto('/');
    await expect(page).toHaveURL(/\/mi-dia$/);
    await expect(page.getByRole('heading', { name: 'Hola, Sara' })).toBeVisible();
    const menu = page.getByRole('navigation', { name: 'Navegación móvil' });
    await expect(menu.getByRole('link', { name: /Mi día/ })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Ventas' })).toHaveCount(0);
  });

  test('toma sola la clienta de la hora y envía a caja lo que le hizo', async ({ page }) => {
    const { sent } = await asStylist(page, [appointment('ap1', 'Rosa Méndez', -10, 50)]);
    await page.goto('/mi-dia');

    await expect(page.getByText('Atendiendo ahora')).toBeVisible();
    await page.getByRole('button', { name: 'Registrar lo que le hice' }).click();

    const registro = page.getByRole('dialog', { name: 'Registrar lo realizado' });
    await expect(registro.getByRole('heading', { level: 2 })).toHaveText(
      '¿Qué le hiciste a Rosa Méndez?',
    );
    // Lo reservado ya viene marcado; solo añade lo que hizo de más.
    await expect(registro.getByRole('button', { name: /Corte de dama/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await registro.getByRole('button', { name: /Tinte completo/ }).click();
    await expect(registro).toContainText(/Q\s*162\.40/);
    await registro.getByRole('button', { name: 'Enviar a caja' }).click();

    await expect(page.getByText(/Enviado a caja: Rosa Méndez/)).toBeVisible();
    expect(sent).toEqual([
      expect.objectContaining({
        serviceIds: ['s1', 's2'],
        appointmentId: 'ap1',
        clientId: 'client-ap1',
      }),
    ]);
    expect(sent[0].stylistId).toBeUndefined();
  });

  test('le recuerda lo que ya atendió y no ha registrado', async ({ page }) => {
    await asStylist(page, [
      appointment('ap0', 'Ana López', -120, -60),
      appointment('ap1', 'Rosa Méndez', -10, 50),
      appointment('ap2', 'María Castillo', 90, 150),
    ]);
    await page.goto('/mi-dia');

    await expect(page.getByRole('heading', { name: 'Falta registrar (1)' })).toBeVisible();
    await expect(page.getByText(/terminó hace 1 h/)).toBeVisible();
    // La que aún no empieza no cuenta: el aviso es por lo que ya tocaba.
    await expect(
      page
        .getByRole('navigation', { name: 'Navegación móvil' })
        .getByRole('link', { name: /Mi día/ }),
    ).toContainText('2');
  });

  test('registra a una clienta sin cita eligiéndola sin escribir', async ({ page }) => {
    const { sent } = await asStylist(page, []);
    await page.goto('/mi-dia');
    await page.getByRole('button', { name: 'Clienta sin cita' }).click();

    const registro = page.getByRole('dialog', { name: 'Registrar lo realizado' });
    await registro.getByRole('combobox').click();
    await registro.getByRole('option', { name: /Ana López/ }).click();
    await registro.getByRole('button', { name: /Corte de dama/ }).click();
    await registro.getByRole('button', { name: 'Enviar a caja' }).click();

    await expect.poll(() => sent[0]).toMatchObject({ serviceIds: ['s1'], clientId: 'c2' });
    expect(sent[0].appointmentId).toBeUndefined();
  });
});

test('recepción registra desde la agenda a nombre de la estilista de la cita', async ({ page }) => {
  const { sent, assignable } = await mockDay(page, {
    role: 'RECEPTIONIST',
    isStylist: false,
    permissions: [
      'appointments.read',
      'appointments.update',
      'clients.read',
      'services.read',
      'stylists.read',
      'service-tickets.read',
      'service-tickets.create',
    ],
    appointments: [appointment('ap1', 'Rosa Méndez', -10, 50)],
  });
  await page.goto('/agenda');
  await page.getByRole('button', { name: /Rosa Méndez/ }).click();
  await page.getByRole('button', { name: 'Registrar lo realizado' }).click();

  const registro = page.getByRole('dialog', { name: 'Registrar lo realizado' });
  await expect(registro).toContainText('Lo registras a nombre de Sara Molina');
  await registro.getByRole('button', { name: 'Enviar a caja' }).click();

  await expect
    .poll(() => sent[0])
    .toMatchObject({
      serviceIds: ['s1'],
      appointmentId: 'ap1',
      stylistId: 'sara',
    });
  expect(assignable).toContain('?stylistId=sara');
});
