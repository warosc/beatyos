# ADR-0007: API REST versionada por URI y contrato OpenAPI

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

La API la consumen clientes que no se despliegan a la vez que el servidor (móviles,
integraciones de terceros). Los cambios incompatibles no pueden romperlos.

## Decisión

- **Versionado por URI**: `/api/v1/...`. Visible en logs, cacheable, trivial de enrutar
  en un balanceador. Se descarta versionar por cabecera (invisible en trazas) y por
  media type (correcto, pero de ergonomía pobre para los clientes previstos).
- **Envoltura de respuesta uniforme** aplicada por interceptor, no repetida en cada
  controlador:

```jsonc
// colección
{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7,
                             "hasNext": true, "hasPrevious": false } }
// recurso
{ "data": { ... } }
```

- **Paginación** por `page`/`limit` (máximo 100, por defecto 20). Se elige offset sobre
  cursor por ser la que encaja con las rejillas de la UI; los endpoints de exportación
  masiva usarán cursor cuando existan.
- **Ordenación**: `?sort=createdAt:desc,name:asc`, validada contra una **lista blanca de
  campos ordenables por recurso**. Nunca se interpola la entrada en la consulta.
- **Filtrado**: parámetros tipados por recurso (`?status=CONFIRMED&from=2026-09-01`), no
  un lenguaje de consulta genérico. Explícito, documentable y sin superficie de inyección.
- **OpenAPI generado del código** con el plugin de Swagger, expuesto en `/api/docs` y
  exportable a `openapi.json` para generar SDKs de cliente.
- **Idempotencia**: las operaciones no seguras que crean dinero o citas aceptan la
  cabecera `Idempotency-Key`.

### Endurecimiento del transporte

| Control | Configuración |
| ------- | ------------- |
| `helmet` | HSTS, `X-Content-Type-Options`, sin `X-Powered-By`, CSP mínima para Swagger |
| CORS | Lista blanca de orígenes por variable de entorno. Nunca `*` con credenciales |
| Rate limiting | Tres niveles: `short` 10/s, `medium` 100/min, `long` 1000/h. `/auth/login` se restringe aparte a 5 intentos / 15 min por IP |
| Límite de cuerpo | 1 MB por defecto |
| Validación | `whitelist` + `forbidNonWhitelisted`: un campo no declarado es un 400, no un campo ignorado en silencio |

## Consecuencias

- Mantener `v1` mientras haya clientes vivos, aunque exista `v2`.
- La envoltura obliga a los clientes a desenvolver `data`; a cambio, añadir metadatos
  (avisos de deprecación, paginación) nunca es un cambio incompatible.
- La paginación por offset se degrada en offsets muy altos. Aceptado: ninguna vista de la
  UI navega más allá de unas decenas de páginas.
- El rate limiting es por instancia mientras el almacén sea en memoria; con más de una
  réplica hay que moverlo a Redis o al balanceador. Anotado como deuda operativa.
