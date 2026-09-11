import type { Page, PageRequest, QueryOptions } from '../../../shared/domain/ports/repository.port';
import type { User, UserStatusValue } from './user.entity';

/**
 * Puerto de persistencia de usuarios (ADR-0001).
 *
 * Lo define el dominio y lo implementa la infraestructura. Es también el contrato que
 * cumple el doble en memoria de la suite unitaria: una batería de tests de contrato lo
 * ejecuta contra ambas implementaciones para que no puedan divergir (ADR-0009).
 */

export interface UserFilter {
  readonly search?: string;
  readonly status?: UserStatusValue;
  readonly roleCode?: string;
}

export type UserSortField = 'createdAt' | 'lastName' | 'email' | 'lastLoginAt' | 'status';

export interface UserRepository {
  findById(id: string, options?: QueryOptions): Promise<User | null>;

  /**
   * Busca por correo **sin filtro de salón**.
   *
   * Es la única consulta del sistema que atraviesa inquilinos por diseño: en el momento
   * del login solo se tiene un correo, y todavía no se sabe a qué salón pertenece. El
   * `tenantId` sale de esta consulta, no entra en ella.
   *
   * La implementación debe envolverla en `QueryScopeStore.crossTenant()`. Como
   * contrapartida, el correo es único en toda la plataforma —dos salones no pueden tener
   * un usuario con el mismo correo—, que es la restricción que hace determinista este
   * método.
   */
  findByEmailAcrossTenants(email: string): Promise<User | null>;

  /**
   * Localiza por id sin filtro de salon.
   *
   * Lo necesita el refresco de sesion: llega sin access token, luego el contexto de
   * peticion todavia no tiene tenant. La excepcion al aislamiento queda **dentro del
   * adaptador**, que es donde puede auditarse de un vistazo, en lugar de que el caso de
   * uso tenga que conocer el mecanismo de ambito de Prisma.
   */
  findByIdAcrossTenants(id: string): Promise<User | null>;

  findByEmail(email: string): Promise<User | null>;

  search(
    filter: UserFilter,
    page: PageRequest<UserSortField>,
    options?: QueryOptions,
  ): Promise<Page<User>>;

  /** Alta. Persiste también la asignación de roles. */
  create(user: User): Promise<User>;

  /** Actualización completa del agregado, incluidos sus roles. */
  update(user: User): Promise<User>;

  /**
   * Persiste solo los campos del intento de acceso.
   *
   * Existe aparte de `update` porque se invoca en el camino del login fallido, donde no
   * se quiere reescribir el agregado entero —ni arriesgarse a pisar cambios ajenos— por
   * incrementar un contador.
   */
  updateLoginState(user: User): Promise<void>;

  softDelete(id: string, actorId: string | null): Promise<void>;
  restore(id: string, actorId: string | null): Promise<User>;

  existsByEmail(email: string, excludeId?: string): Promise<boolean>;

  /**
   * Cuenta las propietarias activas del salón.
   *
   * Sostiene la regla de "no dejar el salón sin propietaria" (`LastOwnerError`). Vive en
   * el repositorio y no en el caso de uso porque contar filas es trabajo de la base de
   * datos: traerse todos los usuarios para contarlos en memoria no escala y, sobre todo,
   * abre una carrera entre la lectura y la escritura.
   */
  countActiveOwners(excludeUserId?: string): Promise<number>;
}

export const USER_REPOSITORY = Symbol('UserRepository');
