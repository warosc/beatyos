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
