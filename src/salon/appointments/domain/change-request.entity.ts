import {
  BusinessRuleViolationError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { AggregateRoot } from '../../../shared/domain/primitives';

/**
 * Solicitud de cambio de hora de una cita.
 *
 * La profesional no mueve sus citas: lo pide, y la encargada decide. La solicitud es el
 * rastro de esa conversación —quién pidió qué, cuándo, y qué se contestó— y es lo que
 * impide que el cambio se pierda en un mensaje de WhatsApp que nadie vuelve a leer.
 *
 * No toca la cita. Aprobarla es solo la mitad: quien aprueba mueve la cita con el caso de
 * uso de siempre, que es el que conoce el horario y el solapamiento. Así la regla de «la
 * cita cabe» vive en un único sitio y no hay una segunda vía de mover citas que la olvide.
 */

export type ChangeRequestStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface ChangeRequestProps {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly stylistId: string;
  readonly requestedBy: string;
  readonly currentStartsAt: Date;
  readonly proposedStartsAt: Date;
  readonly reason: string | null;
  readonly status: ChangeRequestStatusValue;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class AppointmentChangeRequest extends AggregateRoot {
  private constructor(
    id: string,
    private props: ChangeRequestProps,
  ) {
    super(id);
  }

  static open(params: {
    id: string;
    tenantId: string;
    appointmentId: string;
    stylistId: string;
    requestedBy: string;
    currentStartsAt: Date;
    proposedStartsAt: Date;
    reason?: string | null;
    now: Date;
  }): AppointmentChangeRequest {
    if (params.proposedStartsAt.getTime() === params.currentStartsAt.getTime()) {
      throw new BusinessRuleViolationError(
        'CHANGE_REQUEST_SAME_TIME',
        'La hora propuesta es la misma que ya tiene la cita',
      );
    }

    if (params.proposedStartsAt.getTime() < params.now.getTime()) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_IN_THE_PAST',
        'No se puede proponer una hora que ya ha pasado',
      );
    }

    return new AppointmentChangeRequest(params.id, {
      tenantId: params.tenantId,
      appointmentId: params.appointmentId,
      stylistId: params.stylistId,
      requestedBy: params.requestedBy,
      currentStartsAt: params.currentStartsAt,
      proposedStartsAt: params.proposedStartsAt,
      reason: params.reason?.trim() || null,
      status: 'PENDING',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static rehydrate(id: string, props: ChangeRequestProps): AppointmentChangeRequest {
    return new AppointmentChangeRequest(id, props);
  }

  get tenantId(): string {
    return this.props.tenantId;
  }
  get appointmentId(): string {
    return this.props.appointmentId;
  }
  get stylistId(): string {
    return this.props.stylistId;
  }
  get requestedBy(): string {
    return this.props.requestedBy;
  }
  get currentStartsAt(): Date {
    return this.props.currentStartsAt;
  }
  get proposedStartsAt(): Date {
    return this.props.proposedStartsAt;
  }
  get reason(): string | null {
    return this.props.reason;
  }
  get status(): ChangeRequestStatusValue {
    return this.props.status;
  }
  get decidedBy(): string | null {
    return this.props.decidedBy;
  }
  get decidedAt(): Date | null {
    return this.props.decidedAt;
  }
  get decisionNote(): string | null {
    return this.props.decisionNote;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get isPending(): boolean {
    return this.props.status === 'PENDING';
  }

  approve(actorId: string, now: Date, note?: string | null): void {
    this.decide('APPROVED', actorId, now, note);
  }

  /**
   * Rechaza el cambio. Se pide el motivo pero no se exige: a veces es tan obvio como «ese
   * día cierra el salón» y obligar a escribirlo solo estorba a quien organiza el día.
   */
  reject(actorId: string, now: Date, note?: string | null): void {
    this.decide('REJECTED', actorId, now, note);
  }

  /** La propia profesional retira lo que pidió: la clienta ya no puede o se arregló de otra forma. */
  withdraw(actorStylistId: string, actorId: string, now: Date): void {
    if (actorStylistId !== this.props.stylistId) {
      throw new ForbiddenActionError(
        'retirar esta solicitud',
        'Solo quien pidió el cambio puede retirarlo',
      );
    }
    this.decide('WITHDRAWN', actorId, now, null);
  }

  private decide(
    target: Exclude<ChangeRequestStatusValue, 'PENDING'>,
    actorId: string,
    now: Date,
    note: string | null | undefined,
  ): void {
    if (this.props.status !== 'PENDING') {
      throw new InvalidStateTransitionError('La solicitud', this.props.status, target);
    }

    this.props = {
      ...this.props,
      status: target,
      decidedBy: actorId,
      decidedAt: now,
      decisionNote: note?.trim() || null,
      updatedAt: now,
    };
  }
}
