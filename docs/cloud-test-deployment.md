# Despliegue de prueba en Internet

La evaluación en nube usa tres servicios y mantiene la misma arquitectura que el entorno
local:

```text
Vercel (Next.js) → Render (NestJS) → Render PostgreSQL
                                └──→ Cloudflare R2
```

## Cloudflare R2

1. Crear un bucket Standard llamado `beautyos-media`.
2. Crear credenciales S3 con lectura y escritura para ese bucket.
3. Guardar los valores para Render:
   - `S3_ENDPOINT`: `<ACCOUNT_ID>.r2.cloudflarestorage.com`, sin `https://`.
   - `S3_ACCESS_KEY`: Access Key ID del token R2.
   - `S3_SECRET_KEY`: Secret Access Key del token R2.

El endpoint usa el puerto 443, SSL y región `auto`, ya declarados en `render.yaml`.

## Render

Crear un Blueprint desde este repositorio. `render.yaml` provisiona la API y PostgreSQL,
genera secretos JWT y solicita las tres credenciales de R2. El servicio aplica migraciones
y ejecuta el seed idempotente antes de arrancar.

Este despliegue usa `NODE_ENV=development` deliberadamente para cargar el salón de muestra.
Las credenciales de prueba impresas por el seed son:

```text
propietaria@bella-vista.es / SalonDemo2026
encargada@bella-vista.es   / SalonDemo2026
recepcion@bella-vista.es   / SalonDemo2026
estilista@bella-vista.es   / SalonDemo2026
```

Render gratuito duerme la API tras un periodo sin tráfico y su PostgreSQL gratuito expira;
este Blueprint es para evaluación, no para datos reales.

## Vercel

Importar el mismo repositorio con la raíz en el directorio principal. `vercel.json` ejecuta
el build del workspace web. Configurar estas variables para Production, Preview y
Development:

```text
API_URL=https://beautyos-api.onrender.com/api/v1
COOKIE_SECURE=true
```

Si Render o Vercel asignan un sufijo al nombre solicitado, actualizar `API_URL` en Vercel y
`CORS_ORIGINS` en Render con las direcciones efectivas, y volver a desplegar.
