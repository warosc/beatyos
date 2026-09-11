import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ámbito de consulta activo.
 *
 * Existe para resolver un problema concreto de Prisma: no hay forma de expresar "trae
 * también las filas borradas" como un filtro, porque significa *ausencia* de filtro y
 * un filtro ausente es indistinguible de uno olvidado. Pasarlo por parámetro a través
 * de cada repositorio contaminaría todas las firmas.
 *
 * Con un almacén asíncrono, el repositorio base envuelve la consulta y la extensión de
 * Prisma lee la decisión. El resto del código no se entera de que esto existe.
 */

export interface QueryScope {
  /** Desactiva el filtro `deletedAt IS NULL` (ADR-0004). */
  readonly includeDeleted: boolean;
  /** Desactiva el filtro por `tenantId` (ADR-0003). Solo login, seeds y jobs. */
  readonly bypassTenant: boolean;
}

const DEFAULT_SCOPE: QueryScope = { includeDeleted: false, bypassTenant: false };

const storage = new AsyncLocalStorage<QueryScope>();

export const QueryScopeStore = {
  current(): QueryScope {
    return storage.getStore() ?? DEFAULT_SCOPE;
  },

  /**
   * Incluye filas con soft delete durante `work`. Necesario para restaurar y auditar.
   *
   * Nótese el `async () => await work()` en lugar de pasar `work` directamente. No es
   * ruido: **las promesas de Prisma son perezosas**. `prisma.client.findFirst()` no
   * ejecuta nada hasta que se espera, así que `includingDeleted(() => prisma.x.find())`
   * construiría la consulta dentro del ámbito y la ejecutaría fuera —perdiéndolo en
   * silencio y devolviendo un resultado filtrado que nadie esperaba—.
   *
   * Envolviendo en una función asíncrona, el `await` ocurre dentro del ámbito y
   * `AsyncLocalStorage` lo propaga hasta la extensión de Prisma. Así la llamada funciona
   * igual tanto si el argumento es asíncrono como si devuelve una promesa perezosa, y
   * quien lo use no tiene que conocer este detalle.
   */
  includingDeleted<T>(work: () => Promise<T>): Promise<T> {
    return storage.run(
      { ...QueryScopeStore.current(), includeDeleted: true },
      async () => await work(),
    );
  },

  /**
   * Levanta el filtro de tenant durante `work`.
   *
   * Nombre largo a propósito: cada aparición en el código debe llamar la atención en
   * una revisión. Los usos legítimos se cuentan con los dedos de una mano —el login,
   * que aún no sabe a qué salón pertenece un correo, y los procesos de plataforma.
   */
  crossTenant<T>(work: () => Promise<T>): Promise<T> {
    // `async () => await work()` por el mismo motivo que en `includingDeleted`: las
    // promesas de Prisma son perezosas y, sin el await dentro del ambito, la consulta se
    // ejecutaria fuera de el.
    return storage.run(
      { ...QueryScopeStore.current(), bypassTenant: true },
      async () => await work(),
    );
  },
};
