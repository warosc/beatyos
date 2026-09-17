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

const expectedPurchases = {
  '/api/v1/suppliers': { get: 'suppliers_list', post: 'suppliers_create' },
  '/api/v1/suppliers/{id}': { patch: 'suppliers_update', delete: 'suppliers_delete' },
  '/api/v1/suppliers/{id}/restore': { post: 'suppliers_restore' },
  '/api/v1/purchases': { get: 'purchases_list', post: 'purchases_create' },
  '/api/v1/purchases/{id}': { get: 'purchases_get' },
  '/api/v1/purchases/{id}/submit': { post: 'purchases_submit' },
  '/api/v1/purchases/{id}/receive': { post: 'purchases_receive' },
  '/api/v1/purchases/{id}/cancel': { post: 'purchases_cancel' },
};

for (const [path, operations] of Object.entries(expectedPurchases)) {
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

process.stdout.write(
  `Contrato OpenAPI válido: ${Object.keys(document.paths).length} rutas, ${operationIds.size} operaciones únicas.\n`,
);
