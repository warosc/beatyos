import { test as base, expect } from '@playwright/test';

export const owner = {
  id: 'owner',
  tenantId: 'salon-a',
  email: 'owner@example.com',
  firstName: 'Ana',
  lastName: 'Dueña',
  roles: ['OWNER'],
  permissions: ['*'],
};

// These are UI tests with explicit API doubles, not full-stack integration tests.
export const test = base.extend<{ apiDefaults: void }>({
  apiDefaults: [
    async ({ page }, use) => {
      await page.route('**/api/auth/me', (r) => r.fulfill({ json: { data: owner } }));
      await page.route('**/api/reports**', (r) =>
        r.fulfill({ status: 503, json: { detail: 'Informe no disponible en esta prueba.' } }),
      );
      await page.route('**/api/clients?**', (r) =>
        r.fulfill({
          json: {
            data: [],
            meta: {
              page: 1,
              limit: 20,
              total: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }),
      );
      await use();
    },
    { auto: true },
  ],
});
export { expect };
