import { test, expect, owner } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'beautyos_access', value: 'test', domain: '127.0.0.1', path: '/' },
  ]);
});

test('cambiar de cuenta descarta los datos de la sesión anterior', async ({ page, context }) => {
  let account = 'A';
  let reads = 0;
  await page.route('**/api/inventory**', (r) => {
    reads++;
    return r.fulfill({
      json: {
        data: [
          {
            id: 'p',
            sku: 'P',
            name: 'Privado ' + account,
            brand: null,
            price: '1.00',
            currency: 'GTQ',
            stockOnHand: '1',
            reorderPoint: '0',
            stockStatus: 'AVAILABLE',
          },
        ],
      },
    });
  });
  await page.route('**/api/auth/logout', async (r) => {
    await context.clearCookies();
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/auth/login', async (r) => {
    account = 'B';
    await context.addCookies([
      { name: 'beautyos_access', value: 'b', domain: '127.0.0.1', path: '/' },
    ]);
    await r.fulfill({ json: { user: { ...owner, id: 'b', tenantId: 'salon-b' } } });
  });
  await page.goto('/inventario');
  await expect(page.getByText('Privado A', { exact: true })).toBeVisible();
  // Profile exposes logout on desktop and mobile.
  await page.getByRole('link', { name: 'Abrir perfil', exact: true }).click();
  // Use the shell logout where visible; mobile has the same action on profile.
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).last().click();
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('#email').fill('b@example.com');
  await page.locator('#password').fill('ClaveDePrueba2026');
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.locator('a[href="/inventario"]:visible').click();
  await expect(page.getByText('Privado B', { exact: true })).toBeVisible();
  await expect(page.getByText('Privado A', { exact: true })).toHaveCount(0);
  expect(reads).toBeGreaterThan(1);
});

test('el mes se consulta en tramos válidos y la agenda móvil permite desplazamiento', async ({
  page,
}) => {
  const ranges: Array<{ from: number; to: number }> = [];
  await page.route('**/api/agenda**', (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('resource') === 'calendar') {
      const from = Date.parse(u.searchParams.get('from')!);
      const to = Date.parse(u.searchParams.get('to')!);
      ranges.push({ from, to });
      if (to - from > 31 * 86400000)
        return r.fulfill({ status: 422, json: { code: 'CALENDAR_RANGE_TOO_WIDE' } });
    }
    return r.fulfill({ json: { data: [] } });
  });
  await page.goto('/agenda');
  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  await expect
    .poll(() => ranges.filter((x) => (x.to - x.from) / 86400000 >= 12).length)
    .toBeGreaterThanOrEqual(2);
  expect(ranges.every((x) => x.to - x.from <= 31 * 86400000)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  const grid = page.locator('div.min-w-\\[760px\\]');
  expect(await grid.evaluate((el) => getComputedStyle(el.parentElement!).overflowX)).toBe('auto');
});

test('compras conserva el impuesto del producto y recibe fracciones y lotes', async ({ page }) => {
  let orderPayload: Record<string, unknown> | undefined;
  let receiptPayload: Record<string, unknown> | undefined;
  const product = {
    id: 'p',
    sku: 'P',
    name: 'Tinte',
    costPrice: '10.00',
    tracksBatches: true,
    taxRate: '5.00',
  };
  const supplier = { id: 's', code: 'S', name: 'Proveedor', paymentTermDays: 30 };
  const order = {
    id: 'o',
    number: 'OC-1',
    status: 'PARTIALLY_RECEIVED',
    total: '3.15',
    currency: 'GTQ',
    createdAt: '2026-09-01',
    supplier,
    lines: [
      {
        id: 'l',
        productId: 'p',
        quantity: '0.300',
        receivedQuantity: '0.100',
        unitCost: '10.00',
        product,
      },
    ],
  };
  await page.route('**/api/purchases**', (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'GET')
      return r.fulfill({
        json: {
          data:
            u.searchParams.get('resource') === 'products'
              ? [product]
              : u.searchParams.get('resource') === 'suppliers'
                ? [supplier]
                : [order],
        },
      });
    if (u.searchParams.get('action') === 'receive') receiptPayload = r.request().postDataJSON();
    else orderPayload = r.request().postDataJSON();
    return r.fulfill({ json: { data: order } });
  });
  await page.goto('/compras');
  await page.getByRole('button', { name: 'Orden', exact: true }).click();
  await page.getByRole('combobox', { name: 'Proveedor', exact: true }).selectOption('s');
  await page.getByRole('combobox', { name: 'Producto', exact: true }).selectOption('p');
  await page.getByLabel('Cantidad', { exact: true }).fill('0.3');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect.poll(() => orderPayload).toBeTruthy();
  expect((orderPayload!.lines as Array<Record<string, unknown>>)[0]).not.toHaveProperty('taxRate');
  await page.getByRole('button', { name: 'Recibir', exact: true }).click();
  await expect(page.getByLabel('Cantidad de Tinte')).toHaveValue('0.2');
  await page.getByLabel('Lote de Tinte').fill('LOTE-1');
  await page.getByRole('button', { name: 'Confirmar recepción' }).click();
  await expect
    .poll(() => receiptPayload)
    .toEqual({ lines: [{ lineId: 'l', quantity: 0.2, batchNumber: 'LOTE-1' }] });
});

test('recepción ve sus secciones y no las acciones de gestión de inventario', async ({ page }) => {
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      json: {
        data: {
          ...owner,
          permissions: [
            'products.read',
            'inventory.read',
            'clients.read',
            'appointments.read',
            'cash.read',
          ],
          roles: ['RECEPTIONIST'],
        },
      },
    }),
  );
  await page.route('**/api/inventory**', (r) => r.fulfill({ json: { data: [] } }));
  await page.goto('/inventario');
  await expect(page.getByRole('heading', { name: 'Inventario', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Producto', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ajustar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Reportes', exact: true })).toHaveCount(0);
  await page.goto('/configuracion');
  await expect(page.getByRole('heading', { name: 'Sin acceso a esta sección' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(0);
});

test('la búsqueda de inventario y la página siguiente llegan a la API', async ({ page }) => {
  await page.route('**/api/inventory**', (r) => {
    const u = new URL(r.request().url());
    const n = Number(u.searchParams.get('page') ?? 1);
    return r.fulfill({
      json: {
        data: [
          {
            id: String(n),
            sku: 'P',
            name: 'Producto página ' + n,
            price: '1',
            currency: 'GTQ',
            stockOnHand: '1',
            reorderPoint: '0',
            stockStatus: 'AVAILABLE',
          },
        ],
        meta: {
          page: n,
          limit: 20,
          total: 21,
          totalPages: 2,
          hasNext: n === 1,
          hasPrevious: n > 1,
        },
      },
    });
  });
  await page.goto('/inventario');
  await expect(page.getByText('Producto página 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.getByText('Producto página 2', { exact: true })).toBeVisible();
});
