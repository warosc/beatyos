# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Imagen de producción.
#
# Multi-etapa por dos motivos concretos: la imagen final no lleva compilador de
# TypeScript, ni el CLI de Prisma, ni las dependencias de desarrollo —que son el 80% de
# `node_modules` y buena parte de la superficie de ataque—; y las capas se ordenan de
# menos a más cambiante, de modo que editar un fichero de `src/` no invalide la caché de
# la instalación de dependencias.
#
# `@node-rs/argon2` es un binario nativo por plataforma (ADR-0002): esta imagen debe
# construirse para la arquitectura de destino. Copiar `node_modules` desde el host
# produciría un binario que no carga.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22.12.0-alpine3.20

# --- Etapa 1: dependencias de producción -----------------------------------
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

# Solo los manifiestos: mientras no cambien, esta capa se reutiliza entera.
COPY package.json package-lock.json ./

# `npm ci` y no `npm install`: instala exactamente lo del lockfile y falla si diverge.
# Un `install` puede resolver versiones distintas a las probadas, que es lo último que
# uno quiere descubrir en producción.
#
# `--ignore-workspaces` es imprescindible desde que la raíz declara `workspaces`: sin él,
# esta imagen —que solo sirve la API— arrastraría Next.js y todo el frontend de
# `apps/web`, multiplicando su tamaño y su superficie de ataque para no ejecutarlo nunca.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --ignore-workspaces

# --- Etapa 2: compilación ---------------------------------------------------
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --ignore-workspaces

# El cliente de Prisma se genera antes de compilar: el código TypeScript importa sus
# tipos y sin él la compilación falla.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# --- Etapa 3: imagen final --------------------------------------------------
FROM node:${NODE_VERSION} AS production

# `dumb-init` como PID 1. Node no reenvía señales a sus hijos ni recoge procesos
# zombis; sin un init real, un `docker stop` acaba en SIGKILL tras el plazo de gracia y
# las conexiones en vuelo se cortan a la mitad.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Usuario sin privilegios. La imagen de Node ya trae `node` (uid 1000): si un fallo de la
# aplicación permitiera ejecutar código, no lo haría como root.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
# El cliente generado vive dentro de node_modules y hay que traerlo de la etapa de
# compilación: la etapa `deps` instaló con `--ignore-scripts` y no lo generó.
COPY --chown=node:node --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Las migraciones viajan con la imagen: desplegar y migrar deben ser la misma unidad
# desplegable, o acabarán desincronizados.
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

# Sonda de vida, no de disponibilidad: si fallara por una caída de PostgreSQL, Docker
# reiniciaría el contenedor en bucle justo mientras la base se recupera (ver
# health.module.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/api/v1/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
