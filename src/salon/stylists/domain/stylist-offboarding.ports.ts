/**
 * Lo que una profesional tiene pendiente en el salón, para decidir si se le puede dar de baja
 * (ADR-0028).
 *
 * Es un puerto y no una consulta a los repositorios de citas, cola y comandas porque esos
 * módulos ya dependen de este: importarlos desde aquí cerraría un ciclo. El adaptador lee
 * las tablas directamente, solo para contar y listar.
 */
export interface StylistPendingWork {
  /** Citas por atender o en curso. Se listan las primeras; `total` las cuenta todas. */
  readonly appointments: {
    readonly total: number;
    readonly items: readonly PendingAppointment[];
  };
  /** Comandas registradas por ella que caja aún no cobró. */
  readonly pendingTickets: {
    readonly total: number;
    readonly items: readonly PendingTicket[];
  };
  /** Turnos de la cola que está atendiendo o a los que ya la llamaron. */
  readonly activeQueueTurns: readonly ActiveQueueTurn[];
  /** Clientas en espera que la pidieron a ella. No bloquean: pasan a la fila general. */
  readonly waitingPreferences: number;
}

export interface PendingAppointment {
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  readonly clientName: string;
  readonly serviceNames: readonly string[];
}

export interface PendingTicket {
  readonly id: string;
  readonly createdAt: Date;
  readonly clientName: string;
}

export interface ActiveQueueTurn {
  readonly id: string;
  readonly number: number;
  readonly clientName: string;
  readonly status: string;
}

export interface StylistOffboarding {
  pendingWorkOf(stylistId: string, now: Date): Promise<StylistPendingWork>;

  /** Quita la preferencia por ella de los turnos en espera. Devuelve cuántos cambió. */
  releaseQueuePreferences(stylistId: string): Promise<number>;
}

export const STYLIST_OFFBOARDING = Symbol('StylistOffboarding');

/**
 * Si algo pendiente impide la baja.
 *
 * Una cita futura quedaría sin nadie que la atienda; una comanda sin cobrar ya no se podría
 * cobrar, y se perdería su comisión por un trabajo hecho; un turno en curso tiene a una
 * clienta en la silla. Las preferencias de la cola no bloquean: son un deseo, no una cita.
 */
export const blocksRetirement = (work: StylistPendingWork): boolean =>
  work.appointments.total + work.pendingTickets.total + work.activeQueueTurns.length > 0;
