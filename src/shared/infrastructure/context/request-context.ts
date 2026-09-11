import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Contexto de petición (ADR-0003).
 *
 * Guarda quién hace la petición, a qué salón pertenece y con qué identificador de
 * correlación, y lo hace accesible a cualquier profundidad de la pila **sin pasarlo por
 * parámetro**. Sin esto, el `tenantId` tendría que atravesar caso de uso → repositorio →
 * mapeador en cada firma, y bastaría una función que lo olvide para abrir una fuga
 * entre inquilinos.
 *
 * `AsyncLocalStorage` es la pieza del runtime que hace esto seguro: cada petición tiene
 * su propio almacén, aislado incluso a través de `await`. No es una variable global.
 */

export interface RequestContext {
  /** Identificador único de la petición. Une logs, auditoría y respuestas de error. */
  readonly correlationId: string;
  /** Salón activo. `null` en un administrador de plataforma o antes de autenticar. */
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly permissions: readonly string[];
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /**
   * Deja pasar consultas sin filtro de tenant.
   *
   * Reservado a procesos que por definición operan entre inquilinos: el login (que aún
   * no sabe a qué salón pertenece el correo), las migraciones y los seeds. Es la única
   * puerta que puede desactivar el aislamiento, así que es explícita, se activa desde
   * un único método con nombre incómodo y nunca depende de la entrada del usuario.
   */
  readonly bypassTenantScope: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

const ANONYMOUS: RequestContext = {
  correlationId: 'no-context',
  tenantId: null,
  userId: null,
  userEmail: null,
  permissions: [],
  ipAddress: null,
  userAgent: null,
  bypassTenantScope: false,
};

export const RequestContextStore = {
  /** Ejecuta `work` dentro de un contexto nuevo. */
  run<T>(context: Partial<RequestContext>, work: () => T): T {
    return storage.run({ ...ANONYMOUS, correlationId: randomUUID(), ...context }, work);
  },

  /**
   * Contexto actual, o uno anónimo si no lo hay.
   *
   * Devolver un anónimo en lugar de lanzar es deliberado: un seed, un test o un job
   * arrancado fuera de una petición deben poder llamar al mismo código. El aislamiento
   * no depende de que esto lance, sino de que `tenantId` sea `null` y la extensión de
   * Prisma rechace entonces cualquier consulta con ámbito de tenant.
   */
  get(): RequestContext {
    return storage.getStore() ?? ANONYMOUS;
  },

  get tenantId(): string | null {
    return RequestContextStore.get().tenantId;
  },

  get userId(): string | null {
    return RequestContextStore.get().userId;
  },

  get correlationId(): string {
    return RequestContextStore.get().correlationId;
  },

  /** Enriquece el contexto vivo. Lo usa el guard de autenticación tras validar el token. */
  patch(patch: Partial<RequestContext>): void {
    const current = storage.getStore();
    if (!current) return;
    Object.assign(current as unknown as Record<string, unknown>, patch);
  },

  /**
   * Ejecuta `work` sin filtro de tenant.
   *
   * El nombre es largo y desagradable a propósito: debe cantar en una revisión de
   * código. Cada uso nuevo merece que alguien pregunte por qué.
   */
  runWithoutTenantScope<T>(work: () => Promise<T>): Promise<T> {
    const current = storage.getStore() ?? ANONYMOUS;
    // El await va DENTRO del ambito: las promesas de Prisma no ejecutan nada hasta que
    // se esperan, y sin esto la consulta saldria del contexto antes de correr.
    return storage.run({ ...current, bypassTenantScope: true }, async () => await work());
  },

  /** Fija el tenant explícitamente. Para jobs y para el administrador de plataforma. */
  runAsTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const current = storage.getStore() ?? ANONYMOUS;
    return storage.run(
      { ...current, tenantId, bypassTenantScope: false },
      async () => await work(),
    );
  },
};
