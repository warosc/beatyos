import { expect, test } from './fixtures';

test('protege el panel y presenta el inicio de sesión', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ingresar' })).toBeVisible();
});

test('valida las credenciales antes de enviarlas', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page.getByText('Ingresa un correo válido.')).toBeVisible();
  await expect(page.getByText('Ingresa tu contraseña.')).toBeVisible();
});

test.describe('el panel del día en Guatemala', () => {
  test.use({ timezoneId: 'America/Guatemala' });

  test('a las 18:30 sigue pidiendo el día de hoy, no el de mañana', async ({ context, page }) => {
    // A las 18:30 de Guatemala en UTC ya es el día siguiente: el panel mostraba Q0.
    await page.clock.setFixedTime(new Date('2026-10-08T18:30:00-06:00'));
    await context.addCookies([
      { name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' },
    ]);
    const requested: string[] = [];
    await page.route('**/api/reports?**', (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 503, json: { detail: 'Informe no disponible.' } });
    });

    await page.goto('/');

    await expect.poll(() => requested.length).toBeGreaterThan(0);
    const params = new URL(requested[0]).searchParams;
    // Medianoche del 8 de octubre en Guatemala es 06:00 UTC del mismo día.
    expect(params.get('from')).toBe('2026-10-08T06:00:00.000Z');
    expect(params.get('to')).toBe('2026-10-09T05:59:59.999Z');
  });
});

test('permite completar el alta de una clienta', async ({ context, page }) => {
  await context.addCookies([
    { name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' },
  ]);
  await page.route('**/api/clients', async (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 'client-e2e' } }),
      });
    return route.continue();
  });
  await page.goto('/clientes');
  await page.getByRole('button', { name: 'Nueva clienta' }).click();
  await page.getByLabel('Nombre').fill('Rosa');
  await page.getByLabel('Apellido').fill('Iglesias');
  await page.getByLabel('Teléfono').fill('+50255555555');
  await page.getByRole('button', { name: 'Guardar ficha' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
