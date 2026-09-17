# Contrato OpenAPI entre NestJS y Next.js

NestJS es la fuente del contrato HTTP. `docs/openapi.json` se genera desde los
controladores y DTO compilados, y `apps/web/src/generated/api-schema.ts` contiene los tipos
que consume Next.js. Ninguno de estos dos artefactos se edita a mano.

```text
controladores y DTO de NestJS
            ↓ npm run openapi:document
      docs/openapi.json
            ↓ npm run openapi:types
api-schema.ts consumido por Next.js
```

Después de cambiar una ruta, DTO o respuesta, ejecute:

```bash
npm run openapi:generate
```

`npm run openapi:check` regenera ambos artefactos y falla si Git detecta diferencias. Ese
comando es la barrera de CI contra cambios del backend que no llegaron al frontend.

La primera integración tipada cubre compras y proveedores. Sus respuestas HTTP declaran
la envoltura real aplicada por `ResponseEnvelopeInterceptor`, las colecciones paginadas y
los importes como cadenas decimales. `scripts/validate-openapi.mjs` protege sus rutas,
`operationId` y los tipos financieros críticos antes de generar TypeScript.
