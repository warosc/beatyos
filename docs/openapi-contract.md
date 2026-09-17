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

La mayoría de los módulos ya produce esquemas de respuesta tipados —el plugin de Swagger
infiere la forma a partir del tipo de retorno de cada presentador—, pero solo un subconjunto
está **protegido por `scripts/validate-openapi.mjs`**: ese script fija la ruta, el
`operationId` y los campos monetarios críticos de cada operación, así que un cambio que
rompa el contrato falla `npm run openapi:check` en vez de llegar a `apps/web` en silencio.
Hoy cubre compras y proveedores, usuarios, roles, inventario, caja y ventas. Todas sus
respuestas declaran la envoltura real de `ResponseEnvelopeInterceptor`, las colecciones
paginadas y los importes como cadenas decimales.

Agenda, catálogo, clientas y metas ya tienen presentadores tipados —sus rutas se
generan con esquema propio, no `unknown`—, pero ningún test protege que ese `operationId`
o esas rutas no cambien sin querer. Informes y las rutas de fotos de clienta son el hueco
real: sus controladores devuelven objetos sin una clase de respuesta detrás, así que
`api-schema.ts` los tipa como `unknown`.
