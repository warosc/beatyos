import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { CashSession, CashSessionStatusValue } from './cash-session.entity';

export interface CashSessionFilter {
  readonly status?: CashSessionStatusValue;
  readonly openedById?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** Solo las sesiones que cerraron descuadradas. Es la consulta de control. */
  readonly onlyWithDifference?: boolean;
}

export type CashSessionSortField = 'openedAt' | 'closedAt' | 'difference';

export interface CashSessionRepository extends SearchableRepository<
  CashSession,
  CashSessionFilter,
  CashSessionSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<CashSession>;

  /**
   * La caja abierta del salón, si la hay.
   *
   * Devuelve `null` en lugar de lanzar: que no haya caja abierta es un estado normal —el
   * salón está cerrado— y no un error. Quien necesite una abierta para operar es quien debe
   * exigirla, con el mensaje que corresponda a lo que estaba intentando hacer.
   */
  findOpen(): Promise<CashSession | null>;

  /**
   * Crea la sesión reservando la exclusividad de «una caja abierta por salón».
   *
   * La restricción vive en un índice único parcial de PostgreSQL, no en una comprobación
   * previa: entre un `SELECT` que no encuentra caja abierta y el `INSERT` que la crea cabe
   * otra petición, y dos cajas abiertas a la vez reparten los cobros del día entre ambas de
   * forma impredecible. La implementación debe traducir la violación del índice a un
   * conflicto con sentido.
   */
  create(session: CashSession): Promise<CashSession>;

  /** Guarda la sesión **con sus movimientos**. Los movimientos no viven fuera de ella. */
  update(session: CashSession): Promise<CashSession>;

  search(
    filter: CashSessionFilter,
    page: PageRequest<CashSessionSortField>,
    options?: QueryOptions,
  ): Promise<Page<CashSession>>;
}

export const CASH_SESSION_REPOSITORY = Symbol('CashSessionRepository');
