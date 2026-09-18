import { z } from 'zod';

/**
 * Contrato de entorno.
 *
 * Se valida **una vez, al arrancar**, y el proceso aborta si algo falta o no encaja.
 * La alternativa —leer `process.env.X` allá donde haga falta— hace que un secreto mal
 * puesto se manifieste tres horas después, en producción, como un `undefined` dentro de
 * una función de firma. Fallar en el segundo cero es incomparablemente más barato.
 */

const durationPattern = /^\d+[smhd]$/;

const secret = (name: string) =>
  z
    .string({ required_error: `${name} es obligatorio` })
    .min(32, `${name} debe tener al menos 32 caracteres para resistir un ataque de fuerza bruta`);

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

/**
 * Detecta un secreto de juguete en producción. Devuelve el motivo, o `null` si pasa.
 *
 * La primera versión rechazaba cualquier valor que **contuviera** «secret», «test» o
 * «cambiame». Parecía razonable y era un estorbo: descartaba secretos perfectamente
 * válidos por llevar esas letras dentro —un `…_secreto_…` en español, por ejemplo—, y
 * quien lo sufre no entiende por qué su clave de 60 caracteres aleatorios «es de
 * ejemplo». Se descubrió al arrancar la imagen de producción por primera vez.
 *
 * Lo que se comprueba ahora es lo que de verdad indica un secreto sin generar:
 *
 * 1. Que sea **exactamente** uno de los marcadores de la plantilla.
 * 2. Que empiece por un prefijo de marcador (`cambiame_por_…`).
 * 3. Que tenga **poca variedad de caracteres**: un secreto aleatorio de 32 bytes usa
 *    decenas de símbolos distintos; `aaaaaaaa…` o `password_password_…`, muy pocos.
 *
 * Ninguna de las tres da falsos positivos sobre una salida de `randomBytes`.
 */
function weakSecretReason(secret: string): string | null {
  const normalized = secret.trim().toLowerCase();

  const placeholderPrefixes = ['cambiame_por', 'changeme', 'your-secret', 'replace-me', 'insert'];
  if (placeholderPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return 'Sustituya el valor de ejemplo de .env.example por un secreto generado al azar';
  }

  const uniqueCharacters = new Set(normalized).size;
  if (uniqueCharacters < 12) {
    return (
      `El secreto solo usa ${uniqueCharacters} caracteres distintos y no parece aleatorio. ` +
      "Genérelo con: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }

  return null;
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    API_PREFIX: z.string().default('api'),

    DATABASE_URL: z
      .string()
      .url('DATABASE_URL debe ser una URL de conexión válida')
      .refine((v) => v.startsWith('postgres'), 'Solo se soporta PostgreSQL (ADR-0002)'),

    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    JWT_ACCESS_TTL: z
      .string()
      .regex(durationPattern, 'Formato esperado: 15m, 1h, 7d')
      .default('15m'),
    JWT_REFRESH_TTL: z.string().regex(durationPattern).default('7d'),
    JWT_ISSUER: z.string().default('appsalonbelleza'),
    JWT_AUDIENCE: z.string().default('appsalonbelleza-api'),

    // Mínimos de OWASP para Argon2id. Subir memoria antes que tiempo: encarece más el
    // ataque con GPU, que es el escenario realista si se filtra la tabla de usuarios.
    ARGON2_MEMORY_COST: positiveInt.min(8192).default(19_456),
    ARGON2_TIME_COST: positiveInt.min(1).default(2),
    ARGON2_PARALLELISM: positiveInt.min(1).default(1),

    CORS_ORIGINS: z.string().default(''),

    THROTTLE_SHORT_TTL: positiveInt.default(1000),
    THROTTLE_SHORT_LIMIT: positiveInt.default(10),
    THROTTLE_MEDIUM_TTL: positiveInt.default(60_000),
    THROTTLE_MEDIUM_LIMIT: positiveInt.default(100),
    THROTTLE_LONG_TTL: positiveInt.default(3_600_000),
    THROTTLE_LONG_LIMIT: positiveInt.default(1000),
    AUTH_THROTTLE_TTL: positiveInt.default(60_000),
    AUTH_THROTTLE_LIMIT: positiveInt.default(10),

    MAX_FAILED_LOGIN_ATTEMPTS: positiveInt.default(5),
    ACCOUNT_LOCK_MINUTES: positiveInt.default(15),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SWAGGER_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v === 'true'),
    SWAGGER_PATH: z.string().default('api/docs'),

    DEFAULT_CURRENCY: z.string().length(3).toUpperCase().default('GTQ'),
    DEFAULT_TIMEZONE: z.string().default('America/Guatemala'),
    BODY_LIMIT: z.string().default('1mb'),

    // -- Almacen de objetos (ADR-0016) ------------------------------------
    //
    // Hablan el protocolo de S3, asi que valen igual para MinIO en desarrollo que para S3,
    // R2 o Spaces en produccion. Cambiar de proveedor es cambiar estas variables.
    S3_ENDPOINT: z.string().default('localhost'),
    S3_PORT: z.coerce.number().int().positive().max(65535).default(9000),
    S3_USE_SSL: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    S3_ACCESS_KEY: z.string().min(3).default('salon_minio'),
    S3_SECRET_KEY: z.string().min(8).default('salon_minio_dev_password'),
    S3_BUCKET: z.string().min(3).default('salon-media'),
    S3_REGION: z.string().default('us-east-1'),

    /**
     * Vida de las URL firmadas, en segundos.
     *
     * Corta a proposito. Una URL firmada es una llave al fichero para quien la tenga: si se
     * pega en un chat o queda en el historial del navegador, sigue abriendo la foto hasta
     * que caduque. Quince minutos bastan para cargar una galeria y no para que la enlace
     * circule.
     */
    PHOTO_URL_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(900),

    /** Tamano maximo por foto. Un movil actual saca entre 2 y 8 MB. */
    PHOTO_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    // Que ambos secretos coincidan anularía la separación entre access y refresh: un
    // refresh token podría presentarse como access y saltarse la caducidad de 15 minutos
    // que es toda la defensa del modelo (ADR-0005).
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET debe ser distinto de JWT_ACCESS_SECRET (ADR-0005)',
      });
    }

    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        const problem = weakSecretReason(env[key]);
        if (problem) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: problem });
        }
      }
      if (env.CORS_ORIGINS.trim() === '' || env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'En producción CORS_ORIGINS debe ser una lista blanca explícita, nunca "*"',
        });
      }
      if (env.SWAGGER_ENABLED) {
        // No es un fallo de seguridad por sí mismo, pero publica el mapa completo de la
        // API. Se exige desactivarlo de forma consciente.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SWAGGER_ENABLED'],
          message: 'Desactive Swagger en producción o sírvalo tras autenticación',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Valida el entorno y aborta con un informe legible si no cumple.
 *
 * El mensaje enumera **todos** los problemas, no solo el primero: arrancar cinco veces
 * seguidas para descubrir cinco variables mal puestas es una pérdida de tiempo evitable.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const report = result.error.issues
      .map((issue) => `  · ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Configuración de entorno no válida:\n${report}\n\nRevise su fichero .env (plantilla en .env.example).`,
    );
  }

  return result.data;
}

/** Orígenes CORS como lista, ya troceada y saneada. */
export const parseCorsOrigins = (raw: string): string[] =>
  raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
