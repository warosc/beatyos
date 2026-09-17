import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = JSON.parse(
  await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const operationIds = new Set();

for (const [path, item] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    assert.ok(operation.operationId, `${method.toUpperCase()} ${path} no declara operationId`);
    assert.ok(
      !operationIds.has(operation.operationId),
      `operationId duplicado: ${operation.operationId}`,
    );
    operationIds.add(operation.operationId);
  }
}

const expectedRoutes = {
  // Compras y proveedores (primera integración tipada).
  '/api/v1/suppliers': { get: 'suppliers_list', post: 'suppliers_create' },
  '/api/v1/suppliers/{id}': { patch: 'suppliers_update', delete: 'suppliers_delete' },
  '/api/v1/suppliers/{id}/restore': { post: 'suppliers_restore' },
  '/api/v1/purchases': { get: 'purchases_list', post: 'purchases_create' },
  '/api/v1/purchases/{id}': { get: 'purchases_get' },
  '/api/v1/purchases/{id}/submit': { post: 'purchases_submit' },
  '/api/v1/purchases/{id}/receive': { post: 'purchases_receive' },
  '/api/v1/purchases/{id}/cancel': { post: 'purchases_cancel' },

  // Usuarios y roles (ADR-0006).
  '/api/v1/users': { get: 'users_list', post: 'users_create' },
  '/api/v1/users/{id}': { get: 'users_get', patch: 'users_update', delete: 'users_delete' },
  '/api/v1/users/{id}/roles': { put: 'users_assignRoles' },
  '/api/v1/users/{id}/restore': { post: 'users_restore' },
  '/api/v1/roles': { get: 'roles_list', post: 'roles_create' },
  '/api/v1/roles/permissions': { get: 'roles_permissions' },
  '/api/v1/roles/{id}': { patch: 'roles_update', delete: 'roles_delete' },

  // Inventario (ADR-0011, ADR-0012, ADR-0013).
  '/api/v1/products': { get: 'products_list', post: 'products_create' },
  '/api/v1/products/{id}': {
    get: 'products_get',
    patch: 'products_update',
    delete: 'products_delete',
  },
  '/api/v1/products/{id}/restore': { post: 'products_restore' },
  '/api/v1/inventory/kardex': { get: 'inventory_kardex' },
  '/api/v1/inventory/batches': { get: 'inventory_batches' },
  '/api/v1/inventory/alerts': { get: 'inventory_alerts' },
  '/api/v1/inventory/receive': { post: 'inventory_receive' },
  '/api/v1/inventory/consume': { post: 'inventory_consume' },
  '/api/v1/inventory/adjust': { post: 'inventory_adjust' },

  // Caja (ADR-0014).
  '/api/v1/cash/current': { get: 'cash_current' },
  '/api/v1/cash/history': { get: 'cash_history' },
  '/api/v1/cash/open': { post: 'cash_open' },
  '/api/v1/cash/movements': { post: 'cash_movement' },
  '/api/v1/cash/close': { post: 'cash_close' },

  // Ventas y facturación (ADR-0014, ADR-0018).
  '/api/v1/sales': { get: 'sales_list', post: 'sales_create' },
  '/api/v1/sales/{id}': { get: 'sales_get' },
  '/api/v1/sales/{id}/void': { post: 'sales_void' },
};

for (const [path, operations] of Object.entries(expectedRoutes)) {
  assert.ok(document.paths[path], `Falta la ruta ${path}`);
  for (const [method, operationId] of Object.entries(operations)) {
    assert.equal(document.paths[path][method]?.operationId, operationId);
  }
}

const schemas = document.components?.schemas;

assert.ok(schemas?.PurchaseOrderPageResponse?.properties?.data, 'Falta el listado de compras');
assert.equal(schemas.PurchaseOrderResponse.properties.total.type, 'string');
assert.equal(schemas.PurchaseOrderResponse.properties.subtotal.type, 'string');
assert.equal(schemas.PurchaseOrderResponse.properties.taxTotal.type, 'string');
assert.equal(schemas.PurchaseOrderLineResponse.properties.quantity.type, 'string');
assert.equal(schemas.PurchaseOrderLineResponse.properties.unitCost.type, 'string');

assert.ok(schemas.UserPageResponse?.properties?.data, 'Falta el listado de usuarios');
assert.ok(schemas.RoleListEnvelopeResponse?.properties?.data, 'Falta el listado de roles');

assert.ok(schemas.ProductPageResponse?.properties?.data, 'Falta el catálogo de productos');
assert.equal(schemas.ProductResponse.properties.price.type, 'string');
assert.equal(schemas.ProductResponse.properties.stockOnHand.type, 'string');
assert.equal(schemas.InventoryMovementResponse.properties.quantityDelta.type, 'string');
assert.equal(schemas.BatchResponse.properties.unitCost.type, 'string');

assert.equal(schemas.CashSessionResponse.properties.openingFloat.type, 'string');
assert.equal(schemas.CashSessionResponse.properties.expectedAmount.type, 'string');
assert.equal(schemas.CashMovementResponse.properties.amount.type, 'string');

assert.ok(schemas.InvoicePageResponse?.properties?.data, 'Falta el listado de facturas');
assert.equal(schemas.InvoiceResponse.properties.total.type, 'string');
assert.equal(schemas.InvoiceResponse.properties.commissionTotal.type, 'string');
assert.equal(schemas.InvoiceLineResponse.properties.unitPrice.type, 'string');
assert.equal(schemas.PaymentResponse.properties.amount.type, 'string');

process.stdout.write(
  `Contrato OpenAPI válido: ${Object.keys(document.paths).length} rutas, ${operationIds.size} operaciones únicas.\n`,
);
