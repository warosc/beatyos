import { DomainValidationError, InvalidStateTransitionError } from '../../../shared/domain/errors';
import { Entity } from '../../../shared/domain/primitives';
import { formatCalendarDay, instantToCalendarDay } from '../../../shared/domain/time/zoned-time';

/**
 * Turno de la fila de espera (ADR-0024).
 *
 * Una clienta llega sin cita, recepción la anota y espera. Cuando una profesional queda
 * libre la llama —la pantalla del salón lo anuncia—, la atiende y, al terminar, declara lo
 * que le hizo: el turno se cierra con una comanda (ADR-0019) que caja cobra como cualquier
 * otra.
 *
 * | Desde | Acción | Hacia |
 * | ----- | ------ | ----- |
 * | En espera | llamar | Llamada |
 * | Llamada | volver a llamar | Llamada (se anuncia otra vez) |
 * | Llamada | ya está conmigo | En el sillón |
 * | Llamada o en el sillón | terminar, con su comanda | Atendida |
 * | Llamada | no se presentó | No vino |
 * | Llamada | devolver a la fila | En espera, en su sitio |
 * | En espera o llamada | se fue | Cancelada |
 *
 * El turno no lleva precios ni es un cargo: los servicios que guarda son lo que la clienta
 * pidió al llegar, y sirven para saber quién puede atenderla. Lo que se cobra lo decide la
 * comanda al terminar.
 */

export type QueueTurnStatusValue =
  'WAITING' | 'CALLED' | 'IN_SERVICE' | 'DONE' | 'NO_SHOW' | 'CANCELLED';

/** Estados en los que el turno ocupa a una profesional. Como mucho uno por profesional. */
export const ACTIVE_QUEUE_STATUSES: readonly QueueTurnStatusValue[] = ['CALLED', 'IN_SERVICE'];

/** Mismo tope práctico que la comanda en la que acabará convirtiéndose. */
const MAX_SERVICES = 20;

/** Lo mínimo que la fila necesita saber de una profesional para decidir si la atiende. */
export interface QueueAttendant {
  readonly id: string;
  canPerform(serviceId: string): boolean;
}

export interface QueueTurnProps {
  readonly tenantId: string;
  /** Día del salón (`AAAA-MM-DD`, en su zona horaria). La fila empieza de cero cada día. */
  readonly businessDate: string;
  readonly number: number;
  readonly clientId: string | null;
  readonly clientName: string;
  readonly serviceIds: readonly string[];
  readonly preferredStylistId: string | null;
  readonly stylistId: string | null;
  readonly status: QueueTurnStatusValue;
  readonly notes: string | null;
  readonly callCount: number;
  readonly calledAt: Date | null;
  readonly startedAt: Date | null;
  readonly closedAt: Date | null;
  readonly serviceTicketId: string | null;
  readonly cancellationReason: string | null;
  /** Llegada a la fila. Fija el orden: volver a la fila no la manda al final. */
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export class QueueTurn extends Entity {
  private constructor(
    id: string,
    private props: QueueTurnProps,
  ) {
    super(id);
  }

  static register(params: {
    id: string;
    tenantId: string;
    businessDate: string;
    number: number;
    clientId?: string | null;
    clientName: string;
    serviceIds?: readonly string[];
    preferredStylistId?: string | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): QueueTurn {
    const clientName = params.clientName?.trim();
    if (!clientName) {
      throw new DomainValidationError('Indique el nombre de la clienta', 'clientName');
    }

    const serviceIds = [...(params.serviceIds ?? [])];
    if (serviceIds.length > MAX_SERVICES) {
      throw new DomainValidationError(
        `Un turno admite como máximo ${MAX_SERVICES} servicios`,
        'serviceIds',
      );
    }
    if (new Set(serviceIds).size !== serviceIds.length) {
      throw new DomainValidationError('Hay un servicio repetido en el turno', 'serviceIds');
    }
    if (!Number.isInteger(params.number) || params.number < 1) {
      throw new DomainValidationError('El número de turno debe ser positivo', 'number');
    }

    return new QueueTurn(params.id, {
      tenantId: params.tenantId,
      businessDate: params.businessDate,
      number: params.number,
      clientId: params.clientId ?? null,
      clientName,
      serviceIds,
      preferredStylistId: params.preferredStylistId ?? null,
      stylistId: null,
      status: 'WAITING',
      notes: params.notes?.trim() || null,
      callCount: 0,
      calledAt: null,
      startedAt: null,
      closedAt: null,
      serviceTicketId: null,
      cancellationReason: null,
      createdAt: params.now,
      createdBy: params.actorId,
      updatedAt: params.now,
      updatedBy: params.actorId,
    });
  }

  static rehydrate(id: string, props: QueueTurnProps): QueueTurn {
    return new QueueTurn(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get businessDate(): string {
    return this.props.businessDate;
  }
  get number(): number {
    return this.props.number;
  }
  get clientId(): string | null {
    return this.props.clientId;
  }
  get clientName(): string {
    return this.props.clientName;
  }
  get serviceIds(): readonly string[] {
    return this.props.serviceIds;
  }
  get preferredStylistId(): string | null {
    return this.props.preferredStylistId;
  }
  get stylistId(): string | null {
    return this.props.stylistId;
  }
  get status(): QueueTurnStatusValue {
    return this.props.status;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get callCount(): number {
    return this.props.callCount;
  }
  get calledAt(): Date | null {
    return this.props.calledAt;
  }
  get startedAt(): Date | null {
    return this.props.startedAt;
  }
  get closedAt(): Date | null {
    return this.props.closedAt;
  }
  get serviceTicketId(): string | null {
    return this.props.serviceTicketId;
  }
  get cancellationReason(): string | null {
    return this.props.cancellationReason;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get createdBy(): string | null {
    return this.props.createdBy;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get updatedBy(): string | null {
    return this.props.updatedBy;
  }
  get isActive(): boolean {
    return ACTIVE_QUEUE_STATUSES.includes(this.props.status);
  }

  /**
   * Nombre para la pantalla pública: el primero y la inicial del siguiente, «Ana G.».
   *
   * La pantalla la ve toda la sala. Basta para que la clienta se reconozca; el nombre
   * completo no tiene por qué quedar a la vista de quien espera al lado.
   */
  get publicName(): string {
    const [first = '', second] = this.props.clientName.split(/\s+/);
    return second ? `${first} ${second.charAt(0).toUpperCase()}.` : first;
  }

  // -- Reglas ---------------------------------------------------------------

  /**
   * ¿Puede esta profesional atender este turno sin que nadie decida por ella?
   *
   * Sí si la clienta no pidió a otra y ella sabe hacer todo lo que la clienta pide. Es la
   * regla de «llamar siguiente». Recepción puede saltarse la preferencia (`call` con otra
   * profesional), nunca la habilidad.
   */
  canBeAttendedBy(attendant: QueueAttendant): boolean {
    if (this.props.status !== 'WAITING') return false;
    if (this.props.preferredStylistId && this.props.preferredStylistId !== attendant.id) {
      return false;
    }
    return this.canBePerformedBy(attendant);
  }

  /** Sabe hacer todo lo que la clienta pide. Sin servicios anotados, cualquiera. */
  canBePerformedBy(attendant: QueueAttendant): boolean {
    return this.props.serviceIds.every((serviceId) => attendant.canPerform(serviceId));
  }

  // -- Comportamiento -------------------------------------------------------

  /**
   * La profesional la llama. Cada llamada sube el contador, que es lo que la pantalla mira
   * para anunciarla: una clienta devuelta a la fila y llamada de nuevo se vuelve a oír.
   */
  call(stylistId: string, now: Date, actorId: string | null): void {
    this.assertStatus(['WAITING'], 'CALLED');
    this.props = {
      ...this.props,
      status: 'CALLED',
      stylistId,
      callCount: this.props.callCount + 1,
      calledAt: now,
      ...this.touched(now, actorId),
    };
  }

  /** «No me oyó»: se anuncia otra vez, sin cambiar de profesional. */
  recall(now: Date, actorId: string | null): void {
    this.assertStatus(['CALLED'], 'CALLED');
    this.props = {
      ...this.props,
      callCount: this.props.callCount + 1,
      calledAt: now,
      ...this.touched(now, actorId),
    };
  }

  /** La clienta ya está en el sillón. Deja de anunciarse en la pantalla. */
  start(now: Date, actorId: string | null): void {
    this.assertStatus(['CALLED'], 'IN_SERVICE');
    this.props = {
      ...this.props,
      status: 'IN_SERVICE',
      startedAt: now,
      ...this.touched(now, actorId),
    };
  }

  /**
   * Atendida: la comanda que la justifica ya existe.
   *
   * Se admite desde «llamada» porque la profesional que atiende no siempre pulsa «ya está
   * conmigo»; entonces se toma el inicio como el final, que es lo único que se sabe.
   */
  finish(serviceTicketId: string, now: Date, actorId: string | null): void {
    this.assertStatus(['CALLED', 'IN_SERVICE'], 'DONE');
    if (!serviceTicketId) {
      throw new DomainValidationError('Un turno atendido necesita su comanda', 'serviceTicketId');
    }
    this.props = {
      ...this.props,
      status: 'DONE',
      serviceTicketId,
      startedAt: this.props.startedAt ?? now,
      closedAt: now,
      ...this.touched(now, actorId),
    };
  }

  /** La llamaron y no apareció. */
  markNoShow(now: Date, actorId: string | null): void {
    this.assertStatus(['CALLED'], 'NO_SHOW');
    this.props = { ...this.props, status: 'NO_SHOW', closedAt: now, ...this.touched(now, actorId) };
  }

  /**
   * Vuelve a la fila **en su sitio**: la llamaron por error, o la profesional no puede
   * atenderla. El orden lo da la llegada, que no cambia.
   */
  requeue(now: Date, actorId: string | null): void {
    this.assertStatus(['CALLED'], 'WAITING');
    this.props = {
      ...this.props,
      status: 'WAITING',
      stylistId: null,
      calledAt: null,
      ...this.touched(now, actorId),
    };
  }

  /** Se fue sin que la atendieran, o se anotó por error. El motivo es opcional. */
  cancel(reason: string | null | undefined, now: Date, actorId: string | null): void {
    this.assertStatus(['WAITING', 'CALLED'], 'CANCELLED');
    this.props = {
      ...this.props,
      status: 'CANCELLED',
      cancellationReason: reason?.trim() || null,
      closedAt: now,
      ...this.touched(now, actorId),
    };
  }

  private touched(now: Date, actorId: string | null) {
    return { updatedAt: now, updatedBy: actorId };
  }

  private assertStatus(
    allowed: readonly QueueTurnStatusValue[],
    target: QueueTurnStatusValue,
  ): void {
    if (!allowed.includes(this.props.status)) {
      throw new InvalidStateTransitionError('Turno', this.props.status, target);
    }
  }
}

/**
 * Las de la fila que esta profesional puede atender, por orden de llegada: la primera es
 * «la siguiente», y las demás, el relevo si otra profesional se la lleva antes.
 *
 * Las que piden a otra profesional, o un servicio que ella no hace, se saltan **para ella**
 * sin perder su sitio: siguen primeras para quien sí puede.
 */
export function candidatesFor(
  waiting: readonly QueueTurn[],
  attendant: QueueAttendant,
): QueueTurn[] {
  return [...waiting].filter((turn) => turn.canBeAttendedBy(attendant)).sort(byArrival);
}

/** Orden de llegada. El número desempata dos altas en el mismo milisegundo. */
export const byArrival = (a: QueueTurn, b: QueueTurn): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number;

/** Día del salón al que pertenece un instante: `AAAA-MM-DD` en su zona horaria. */
export const businessDateOf = (instant: Date, timeZone: string): string =>
  formatCalendarDay(instantToCalendarDay(instant, timeZone));
