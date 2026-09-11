/**
 * Politica de autenticacion.
 *
 * Existe como puerto —y no como una lectura directa de `ConfigService`— para que la capa
 * de aplicacion no importe infraestructura (ADR-0001). El caso de uso declara *que*
 * necesita un umbral de intentos; *de donde* sale ese numero (variables de entorno hoy,
 * ajustes por salon manana) es decision del modulo que lo provee.
 *
 * El beneficio inmediato aparece en los tests: fijar el umbral en 3 para probar el
 * bloqueo es pasar un objeto literal, no montar un `ConfigModule`.
 */
export interface AuthPolicy {
  readonly maxFailedLoginAttempts: number;
  readonly accountLockMinutes: number;
}

export const AUTH_POLICY = Symbol('AuthPolicy');
