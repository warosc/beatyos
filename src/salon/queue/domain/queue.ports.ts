import type { QueueTurn, QueueTurnStatusValue } from './queue-turn.entity';

// ---------------------------------------------------------------------------
// Turnos
// ---------------------------------------------------------------------------

export interface QueueTurnRepository {
  findByIdOrFail(id: string): Promise<QueueTurn>;

  /** Turno llamado o en el sillón de esta profesional, sea del día que sea. */
  findActiveByStylist(stylistId: string): Promise<QueueTurn | null>;

  /** En espera ese día, por orden de llegada. */
  listWaiting(businessDate: string): Promise<QueueTurn[]>;

  /**
   * Lo que pinta el tablero: todo lo de ese día y, de días anteriores, lo que siga activo
   * —una profesional que cerró sin terminar el último turno no debe perderlo de vista—.
   */
  listForBoard(businessDate: string): Promise<QueueTurn[]>;

  /**
   * Siguiente número del día. Se incrementa con bloqueo de fila dentro de la transacción del
   * turno: dos altas simultáneas no reciben el mismo número, y un alta que se deshace no lo
   * consume.
   */
  nextNumber(businessDate: string): Promise<number>;

  create(turn: QueueTurn): Promise<QueueTurn>;

  /**
   * Persiste el cambio **solo si el turno seguía en `expected`** en la base.
   *
   * Es lo que impide que dos profesionales se lleven a la misma clienta: ambas la leen en
   * espera, pero la segunda escritura no encuentra fila y falla con `QUEUE_TURN_CHANGED`.
   * Si la profesional ya tenía otra clienta activa, el índice único parcial lo rechaza con
   * `QUEUE_STYLIST_BUSY`.
   */
  update(turn: QueueTurn, expected: QueueTurnStatusValue): Promise<QueueTurn>;
}

export const QUEUE_TURN_REPOSITORY = Symbol('QueueTurnRepository');

// ---------------------------------------------------------------------------
// Pantalla del salón
// ---------------------------------------------------------------------------

export interface QueueDisplaySalon {
  readonly tenantId: string;
  readonly name: string;
}

/**
 * Enlace de la pantalla de turnos de un salón.
 *
 * Se guarda su hash, nunca el enlace. Emitir uno nuevo invalida el anterior: es la forma de
 * retirar el acceso a una pantalla que ya no debería mostrar la fila.
 */
export interface QueueDisplayLinks {
  replace(tenantId: string, tokenDigest: string): Promise<void>;
  isActive(tenantId: string): Promise<boolean>;
  findSalonByDigest(tokenDigest: string): Promise<QueueDisplaySalon | null>;
}

export const QUEUE_DISPLAY_LINKS = Symbol('QueueDisplayLinks');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface QueueSettings {
  /** Zona del salón: decide a qué día pertenece un turno y cuándo empieza la fila nueva. */
  readonly timeZone: string;
}

export const QUEUE_SETTINGS = Symbol('QueueSettings');
