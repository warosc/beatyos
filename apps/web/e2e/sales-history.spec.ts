import type { Page } from '@playwright/test';
import { expect, owner, test } from './fixtures';

const payment = (method: string, amount: string, extra: Record<string, unknown> = {}) => ({
  id: `p-${method}`,
  method,
  status: 'COMPLETED',
  amount,
  refundedAmount: '0.00',
  reference: null,
  receivedAt: new Date().toISOString(),
  refundedAt: null,
  ...extra,
});

const sale = (overrides: Record<string, unknown> = {}) => ({
  id: 'sale-1',
  number: 'F-2026-000010',
  status: 'PAID',
  clientName: 'Rosa Méndez',
  createdByName: 'Lucía Fernández',
  issuedAt: new Date().toISOString(),
  voidedAt: null,
  voidReason: null,
  subtotal: '100.00',
  discountTotal: '0.00',
  taxTotal: '12.00',
  total: '112.00',
  currency: 'GTQ',
  lines: [
    {
      id: 'l1',
      kind: 'SERVICE',
      description: 'Corte de dama',
      quantity: '1.000',
      unitPrice: '100.00',
      discountAmount: '0.00',
      taxAmount: '12.00',
      lineTotal: '112.00',
      stylistName: 'Sofía López',
    },
  ],
  payments: [payment('CASH', '112.00')],
  ...overrides,
});

const summary = {
  count: 2,
  total: '162.00',
  discountTotal: '0.00',
  voidCount: 1,
  currency: 'GTQ',
  byMethod: [
    { method: 'CASH', received: '112.00', refunded: '0.00', net: '112.00' },
    { method: 'CARD', received: '80.00', refunded: '30.00', net: '50.00' },
  ],
};

async function mockSales(
  page: Page,
  { cashOpen = true, permissions }: { cashOpen?: boolean; permissions?: string[] } = {},
) {
  await page
    .context()
    .addCookies([{ name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
  if (permissions) {
    await page.route('**/api/auth/me', (r) =>
      r.fulfill({ json: { data: { ...owner, roles: ['RECEPTIONIST'], permissions } } }),
    );
  }
  const voids: unknown[] = [];
  await page.route('**/api/sales?**', (r) =>
    r.fulfill({
      json: {
        data: [
          sale(),
          sale({ id: 'sale-2', number: 'F-2026-000011', status: 'VOID', total: '50.00' }),
        ],
        meta: { page: 1, limit: 25, total: 2, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    }),
  );
  await page.route('**/api/sales/summary?**', (r) => r.fulfill({ json: { data: summary } }));
  await page.route('**/api/sales/sale-1', (r) => r.fulfill({ json: { data: sale() } }));
  await page.route('**/api/sales/sale-1/void', (route) => {
    voids.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { data: sale({ status: 'VOID', voidReason: 'Error' }) },
    });
  });
  await page.route('**/api/tenant/profile', (r) =>
    r.fulfill({
      json: {
        data: {
          name: 'Marian Salón',
          legalName: 'Marian Salón, S.A.',
          taxId: '1234567-8',
          addressLine: '6a avenida 1-23',
          city: 'Guatemala',
          phone: '5580 8119',
          email: 'hola@marian.gt',
          brandTheme: 'menta-rosa',
          receiptNote: 'Síguenos en @mariansalon',
        },
      },
    }),
  );
  await page.route('**/api/cash?resource=current', (r) =>
    r.fulfill({
      json: { data: cashOpen ? { id: 'cash-1', openedAt: new Date().toISOString() } : null },
    }),
  );
  return voids;
}

test('muestra lo cobrado por método para cuadrar el día', async ({ page }) => {
  await mockSales(page);
  await page.goto('/ventas/historial');
  const totales = page.getByLabel('Totales del periodo');
  await expect(totales).toContainText('2 ventas');
  await expect(totales).toContainText(/Efectivo\s*Q\s*112\.00/);
  await expect(totales).toContainText(/Tarjeta\s*Q\s*50\.00/);
  await expect(totales).toContainText('1 anuladas aparte');
  await expect(page.getByRole('row', { name: /F-2026-000011/ })).toContainText('Anulada');
});

test('abre el comprobante y la propietaria anula la venta', async ({ page }) => {
  const voids = await mockSales(page);
  await page.goto('/ventas/historial');
  await page.getByRole('row', { name: /F-2026-000010/ }).click();

  const venta = page.getByRole('dialog', { name: 'Venta F-2026-000010' });
  await expect(venta).toContainText('COMPROBANTE DE VENTA');
  await expect(venta).toContainText('NIT: 1234567-8');
  await expect(venta).toContainText('con Sofía López');
  await expect(venta).toContainText('Síguenos en @mariansalon');

  await venta.getByRole('button', { name: 'Anular venta' }).click();
  await expect(venta).toContainText(/Salen\s*Q\s*112\.00\s*en efectivo de la caja abierta/);
  await venta.getByLabel('Motivo').fill('Cobrada a la clienta equivocada');
  await venta.getByRole('button', { name: 'Anular venta' }).click();

  await expect(venta).toContainText('Venta F-2026-000010 anulada');
  expect(voids).toEqual([{ reason: 'Cobrada a la clienta equivocada' }]);
});

test('recepción consulta y reimprime, pero no anula', async ({ page }) => {
  await mockSales(page, {
    permissions: ['invoices.read', 'invoices.create', 'payments.create', 'cash.read'],
  });
  await page.goto('/ventas/historial');
  await page.getByRole('row', { name: /F-2026-000010/ }).click();
  const venta = page.getByRole('dialog', { name: 'Venta F-2026-000010' });
  await expect(venta.getByRole('button', { name: 'Imprimir' })).toBeVisible();
  await expect(venta.getByRole('button', { name: 'Anular venta' })).toHaveCount(0);
});

test('no deja anular una venta en efectivo con la caja cerrada', async ({ page }) => {
  await mockSales(page, { cashOpen: false });
  await page.goto('/ventas/historial');
  await page.getByRole('row', { name: /F-2026-000010/ }).click();
  const venta = page.getByRole('dialog', { name: 'Venta F-2026-000010' });
  await venta.getByRole('button', { name: 'Anular venta' }).click();
  await venta.getByLabel('Motivo').fill('Cobrada por error');
  await expect(venta.getByRole('alert')).toContainText('la caja está cerrada');
  await expect(venta.getByRole('button', { name: 'Anular venta' })).toBeDisabled();
});

test('Caja resume el turno por método y lo recuerda al cerrar', async ({ page }) => {
  await mockSales(page);
  const session = {
    id: 'cash-1',
    status: 'OPEN',
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    closedAt: null,
    openedById: 'owner',
    closedById: null,
    openingFloat: '100.00',
    cashSales: '112.00',
    expectedAmount: '212.00',
    countedAmount: null,
    difference: null,
    currency: 'GTQ',
    movements: [],
  };
  await page.route('**/api/cash?**', (r) =>
    r.fulfill({
      json: {
        data: new URL(r.request().url()).searchParams.get('resource') === 'history' ? [] : session,
      },
    }),
  );
  await page.route('**/api/service-tickets?**', (r) => r.fulfill({ json: { data: [] } }));
  await page.goto('/caja');

  await expect(page.getByRole('row', { name: /Tarjeta/ })).toContainText(/Q\s*50\.00/);
  await page.getByRole('button', { name: 'Cerrar caja' }).click();
  await expect(page.getByRole('dialog', { name: 'Caja' })).toContainText(
    /Tarjeta del turno.*Q\s*50\.00/,
  );
});
