import { expect, test } from './fixtures';

const profile = {
  id: 'salon-a',
  name: 'Marian Salon',
  legalName: null,
  taxId: null,
  addressLine: null,
  city: null,
  phone: null,
  email: 'hola@marian.gt',
  brandTheme: 'terracota',
  receiptNote: null,
};

test('la propietaria elige los colores del salón y quedan aplicados', async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: 'beautyos_access', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
  let saved: Record<string, unknown> = { ...profile };
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/tenant/profile', (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON() as Record<string, unknown>);
      saved = { ...saved, ...patches.at(-1) };
    }
    return route.fulfill({ json: { data: saved } });
  });

  await page.goto('/configuracion');
  await expect(page.locator('html')).toHaveAttribute('data-brand', 'terracota');

  await page.getByLabel('Dirección').fill('Zona 4 de Mixco');
  await page.getByLabel('Texto adicional del comprobante').fill('Síguenos en @mariansalon');
  await page.getByText('Menta y rosa').click();
  await page.getByRole('button', { name: 'Guardar' }).click();

  await expect(page.getByText('Datos del salón guardados.')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-brand', 'menta-rosa');
  expect(patches[0]).toMatchObject({
    addressLine: 'Zona 4 de Mixco',
    receiptNote: 'Síguenos en @mariansalon',
    brandTheme: 'menta-rosa',
  });

  // Se recuerda en el navegador: la pantalla de inicio de sesión ya sale con esos colores.
  await page.context().clearCookies({ name: 'beautyos_access' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-brand', 'menta-rosa');
});
