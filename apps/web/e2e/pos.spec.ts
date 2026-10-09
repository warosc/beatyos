import type { Page } from '@playwright/test';
import { expect, owner, test } from './fixtures';

type SaleBody = {
  lines: Array<{ itemId: string; stylistId?: string; discountAmount?: number }>;
  payments: Array<{ method: string; amount: number; reference?: string }>;
};

const corte = {
  id: 'service-1',
  name: 'Corte de dama',
  // Con el IVA dentro (ADR-0021): 25,00 de base más el 12 %.
  price: '28.00',
  taxRate: 12,
  color: '#db2777',
  durationMinutes: 45,
};
const stylists = [
  { id: 'sofia', displayName: 'Sofía', skills: [] },
  { id: 'karla', displayName: 'Karla', skills: [] },
];

/**
 * Dobles de la API para el punto de venta. `cashOpen` decide si hay caja abierta y
 * `permissions` sustituye los de la propietaria para probar otros puestos.
 */
async function openPos(
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
  await page.route('**/api/agenda?resource=**', (route) => {
    const resource = new URL(route.request().url()).searchParams.get('resource');
    const data = resource === 'services' ? [corte] : resource === 'stylists' ? stylists : [];
    return route.fulfill({ json: { data } });
  });
  await page.route('**/api/inventory?resource=products**', (r) =>
    r.fulfill({ json: { data: [] } }),
  );
  await page.route('**/api/stylists/me', (r) => r.fulfill({ json: { data: null } }));
  await page.route('**/api/service-tickets?**', (r) => r.fulfill({ json: { data: [] } }));
  await page.route('**/api/cash?resource=current', (r) =>
    r.fulfill({ json: { data: cashOpen ? { id: 'cash-1', status: 'OPEN' } : null } }),
  );
  const sales: SaleBody[] = [];
  // La API devuelve la venta completa: es lo que se imprime en el momento del cobro.
  const saved = {
    id: 'sale-7',
    number: 'F-2026-000007',
    status: 'PAID',
    clientName: null,
    createdByName: null,
    issuedAt: new Date().toISOString(),
    voidedAt: null,
    voidReason: null,
    subtotal: '50.00',
    discountTotal: '0.00',
    taxTotal: '6.00',
    total: '56.00',
    currency: 'GTQ',
    lines: [
      {
        id: 'l1',
        kind: 'SERVICE',
        description: 'Corte de dama',
        quantity: '2.000',
        unitPrice: '28.00',
        discountAmount: '0.00',
        taxAmount: '6.00',
        lineTotal: '56.00',
        stylistName: null,
      },
    ],
    payments: [
      {
        id: 'p1',
        method: 'CASH',
        status: 'COMPLETED',
        amount: '28.00',
        refundedAmount: '0.00',
        reference: null,
        receivedAt: new Date().toISOString(),
        refundedAt: null,
      },
    ],
  };
  await page.route('**/api/sales', (route) => {
    sales.push(route.request().postDataJSON() as SaleBody);
    return route.fulfill({ status: 201, json: { data: saved } });
  });
  await page.route('**/api/sales/sale-7', (route) => route.fulfill({ json: { data: saved } }));
  await page.goto('/ventas');
  return sales;
}

const addCorte = (page: Page) => page.getByRole('option', { name: /Corte de dama/ }).click();

test('atribuye cada línea a su estilista, aunque sea el mismo servicio', async ({ page }) => {
  const sales = await openPos(page);
  const atiende = page.getByLabel('Profesional de las líneas nuevas');

  await atiende.selectOption({ label: 'Sofía' });
  await addCorte(page);
  await atiende.selectOption({ label: 'Karla' });
  await addCorte(page);

  await expect(
    page.getByRole('list', { name: 'Líneas de la cuenta' }).getByRole('listitem'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: /Cobrar/ }).click();
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.getByLabel('Referencia del pago 1').fill('4242');
  await page.getByRole('button', { name: /Confirmar/ }).click();

  await expect(page.getByText('Venta F-2026-000007 completada')).toBeVisible();
  expect(sales[0].lines.map((line) => line.stylistId)).toEqual(['sofia', 'karla']);
  expect(sales[0].payments).toEqual([{ method: 'CARD', amount: 56, reference: '4242' }]);
});

test('no pierde el segundo artículo si se teclea antes de que llegue el primero', async ({
  page,
}) => {
  await openPos(page);
  const catalog = [corte, { ...corte, id: 'service-2', name: 'Tinte completo' }];
  await page.route('**/api/agenda?resource=services**', async (route) => {
    const search = new URL(route.request().url()).searchParams.get('search') ?? '';
    // La primera búsqueda tarda: es cuando una cajera rápida ya va por el artículo siguiente.
    if (search === 'corte') await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      json: { data: catalog.filter((s) => s.name.toLowerCase().includes(search.toLowerCase())) },
    });
  });

  const search = page.getByRole('combobox', { name: 'Buscar servicio o producto' });
  await search.fill('corte');
  await search.press('Enter');
  await search.fill('tinte');
  await search.press('Enter');

  const lines = page.getByRole('list', { name: 'Líneas de la cuenta' }).getByRole('listitem');
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Tinte completo' })).toHaveCount(1);
  await expect(lines.filter({ hasText: 'Corte de dama' })).toHaveCount(1);
});

test('recepción cobra a precio de lista: no ve descuentos', async ({ page }) => {
  await openPos(page, {
    permissions: [
      'services.read',
      'stylists.read',
      'invoices.create',
      'payments.create',
      'cash.read',
    ],
  });
  await addCorte(page);
  await expect(page.getByRole('button', { name: 'Descuento' })).toHaveCount(0);
});

test('la propietaria aplica un descuento en porcentaje sobre lo que paga la clienta', async ({
  page,
}) => {
  const sales = await openPos(page);
  await addCorte(page);
  await page.getByRole('button', { name: 'Descuento' }).click();
  await page.getByLabel('Descuento', { exact: true }).fill('10');
  await page.getByRole('button', { name: '%', exact: true }).click();
  await page.getByRole('button', { name: 'Aplicar' }).click();

  // 28,00 − 10 % = 25,20: el descuento es sobre el precio con IVA.
  await expect(page.getByRole('button', { name: /Cobrar Q\s*25\.20/ })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByRole('button', { name: /Confirmar/ }).click();
  await expect.poll(() => sales[0]?.lines[0].discountAmount).toBe(2.8);
});

test('divide el pago entre efectivo y tarjeta', async ({ page }) => {
  const sales = await openPos(page);
  await addCorte(page);
  await page.keyboard.press('F2');
  await page.getByRole('button', { name: 'Dividir pago' }).click();
  await page.getByLabel('Importe del pago 1').fill('10');
  await expect(page.getByLabel('Importe del pago 2')).toHaveValue('18.00');
  await page.getByRole('button', { name: /Confirmar/ }).click();

  await expect
    .poll(() => sales[0]?.payments)
    .toEqual([
      { method: 'CASH', amount: 10 },
      { method: 'CARD', amount: 18 },
    ]);
});

test('cobra una parte en efectivo y el resto con tarjeta desde lo recibido', async ({ page }) => {
  const sales = await openPos(page);
  await addCorte(page);
  await page.keyboard.press('F2');
  // La clienta entrega 10 de los 28: se ofrece cobrar lo que falta con otro método.
  await page.getByLabel('Efectivo recibido').fill('10');
  await expect(page.getByText(/Faltan\s*Q\s*18\.00/)).toBeVisible();
  await page.getByRole('button', { name: 'Resto con tarjeta' }).click();
  await expect(page.getByLabel('Importe del pago 1')).toHaveValue('10.00');
  await expect(page.getByLabel('Importe del pago 2')).toHaveValue('18.00');
  await page.getByRole('button', { name: /Confirmar/ }).click();

  await expect
    .poll(() => sales[0]?.payments)
    .toEqual([
      { method: 'CASH', amount: 10 },
      { method: 'CARD', amount: 18 },
    ]);
});

test('imprime el comprobante al cobrar, con lo recibido y el vuelto', async ({ page }) => {
  await openPos(page);
  await addCorte(page);
  await page.keyboard.press('F2');
  await page.getByLabel('Efectivo recibido').fill('50');
  await page.getByLabel('Efectivo recibido').press('Enter');
  await page.getByRole('button', { name: 'Imprimir comprobante' }).click();

  const comprobante = page.getByRole('dialog', { name: 'Venta F-2026-000007' });
  await expect(comprobante).toContainText('COMPROBANTE DE VENTA');
  await expect(comprobante).toContainText(/Recibido\s*Q\s*50\.00/);
  await expect(comprobante).toContainText(/Vuelto\s*Q\s*22\.00/);
  await comprobante.getByRole('button', { name: 'Nueva venta' }).click();
  await expect(page.getByRole('combobox', { name: 'Buscar servicio o producto' })).toBeFocused();
});

test('tras cobrar, Enter empieza la venta siguiente', async ({ page }) => {
  await openPos(page);
  await addCorte(page);
  await page.keyboard.press('F2');
  await page.getByLabel('Efectivo recibido').fill('50');
  await page.getByLabel('Efectivo recibido').press('Enter');
  await expect(page.getByText('Venta F-2026-000007 completada')).toBeVisible();

  // El foco está en «Nueva venta», no en «Imprimir comprobante».
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Venta completada' })).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Venta F-2026-000007' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Buscar servicio o producto' })).toBeFocused();
});

test('con la caja cerrada no deja cobrar en efectivo', async ({ page }) => {
  await openPos(page, { cashOpen: false });
  await addCorte(page);
  await expect(page.getByText('Caja cerrada')).toBeVisible();
  await page.keyboard.press('F2');
  await expect(page.getByRole('button', { name: 'Efectivo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Tarjeta', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(/La caja está cerrada/)).toBeVisible();
});

test('cobra en Caja un servicio de estilista y muestra el vuelto', async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
  const ticket = {
    id: 'ticket-1',
    status: 'PENDING',
    stylistId: 'sofia',
    stylistName: 'Sofía',
    clientId: null,
    clientName: 'Rosa Méndez',
    appointmentId: null,
    invoiceId: null,
    notes: null,
    lines: [
      {
        serviceId: 'service-1',
        name: 'Corte de dama',
        unitPrice: '28.00',
        taxRate: 12,
        lineTotal: '28.00',
        available: true,
      },
    ],
    total: '28.00',
    currency: 'GTQ',
    createdAt: new Date().toISOString(),
    chargedAt: null,
    cancelledAt: null,
    cancellationReason: null,
  };
  let charge: unknown = null;
  await page.route('**/api/service-tickets?**', (r) =>
    r.fulfill({
      json: {
        data: [ticket],
        meta: { page: 1, limit: 50, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
      },
    }),
  );
  await page.route('**/api/service-tickets/ticket-1/charge', (route) => {
    charge = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: { data: { ticketId: 'ticket-1', number: 'F-2026-000009', total: '28.00' } },
    });
  });
  await page.route('**/api/cash**', (r) =>
    r.fulfill({
      json: {
        data:
          new URL(r.request().url()).searchParams.get('resource') === 'history'
            ? []
            : {
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
              },
      },
    }),
  );

  await page.route('**/api/admin?resource=users**', (r) => r.fulfill({ json: { data: [] } }));
  await page.goto('/caja');
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByLabel('Efectivo recibido').fill('100');
  await expect(page.getByText(/Q\s*72\.00/)).toBeVisible();
  await page.getByLabel('Efectivo recibido').press('Enter');

  await expect(page.getByText('Venta F-2026-000009 completada')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Venta completada' })).toContainText(/72\.00/);
  expect(charge).toEqual({ payments: [{ method: 'CASH', amount: 28 }] });
});
