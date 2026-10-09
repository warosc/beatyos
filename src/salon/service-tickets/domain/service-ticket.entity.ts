import { DomainValidationError, InvalidStateTransitionError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';

/**
 * Comanda de servicio (ADR-0019).
 *
 * Es la declaración de una profesional: «a esta clienta le hice esto». Caja la ve como
 * pendiente y, al cobrarla, se emite la factura. La comanda **no es un documento fiscal**
 * y por eso no lleva precios: el importe lo fija la factura, con la tarifa del catálogo en
 * el momento de cobrar, exactamente igual que una venta de mostrador.
 *
 * Solo una comanda pendiente cambia. Cobrada o anulada es historia: si hubo un error se
 * anula la factura por el cauce de siempre, no se reabre la comanda.
 */

export type ServiceTicketStatusValue = 'PENDING' | 'CHARGED' | 'CANCELLED';

/** Tope práctico: una visita con más servicios que esto es un error de manejo. */
const MAX_SERVICES = 20;

export interface ServiceTicketProps {
  readonly tenantId: string;
  readonly stylistId: string;
  readonly clientId: string | null;
  readonly clientName: string;
  readonly appointmentId: string | null;
  readonly invoiceId: string | null;
  readonly status: ServiceTicketStatusValue;
  readonly serviceIds: readonly string[];
  readonly notes: string | null;
  readonly chargedAt: Date | null;
  readonly chargedBy: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly cancellationReason: string | null;
  readonly audit: AuditMetadata;
}

export class ServiceTicket extends Entity {
  private constructor(
    id: string,
    private props: ServiceTicketProps,
  ) {
    super(id);
  }

  static register(params: {
    id: string;
    tenantId: string;
    stylistId: string;
    clientId?: string | null;
    clientName: string;
    appointmentId?: string | null;
    serviceIds: readonly string[];
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): ServiceTicket {
    if (params.serviceIds.length === 0) {
      throw new DomainValidationError('Indique al menos un servicio realizado', 'serviceIds');
    }
    if (params.serviceIds.length > MAX_SERVICES) {
      throw new DomainValidationError(
        `Una comanda admite como máximo ${MAX_SERVICES} servicios`,
        'serviceIds',
      );
    }
    if (new Set(params.serviceIds).size !== params.serviceIds.length) {
      // La factura rechazaría la línea repetida al cobrar. Decirlo ahora ahorra a caja
      // una comanda que no se puede cobrar.
      throw new DomainValidationError('Hay un servicio repetido en la comanda', 'serviceIds');
    }

    const clientName = params.clientName?.trim();
    if (!clientName) {
      throw new DomainValidationError('Indique a qué clienta se le realizó el servicio', 'client');
    }

    return new ServiceTicket(params.id, {
      tenantId: params.tenantId,
      stylistId: params.stylistId,
      clientId: params.clientId ?? null,
      clientName,
      appointmentId: params.appointmentId ?? null,
      invoiceId: null,
      status: 'PENDING',
      serviceIds: [...params.serviceIds],
      notes: params.notes?.trim() || null,
      chargedAt: null,
      chargedBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: ServiceTicketProps): ServiceTicket {
    return new ServiceTicket(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get stylistId(): string {
    return this.props.stylistId;
  }
  get clientId(): string | null {
    return this.props.clientId;
  }
  get clientName(): string {
    return this.props.clientName;
  }
  get appointmentId(): string | null {
    return this.props.appointmentId;
  }
  get invoiceId(): string | null {
    return this.props.invoiceId;
  }
  get status(): ServiceTicketStatusValue {
    return this.props.status;
  }
  get serviceIds(): readonly string[] {
    return this.props.serviceIds;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get chargedAt(): Date | null {
    return this.props.chargedAt;
  }
  get chargedBy(): string | null {
    return this.props.chargedBy;
  }
  get cancelledAt(): Date | null {
    return this.props.cancelledAt;
  }
  get cancelledBy(): string | null {
    return this.props.cancelledBy;
  }
  get cancellationReason(): string | null {
    return this.props.cancellationReason;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isPending(): boolean {
    return this.props.status === 'PENDING';
  }

  // -- Comportamiento -------------------------------------------------------

  /** La marca caja al cobrar, enlazando la factura que la justifica. */
  markCharged(invoiceId: string, now: Date, actorId: string | null): void {
    this.assertPending('CHARGED');
    if (!invoiceId) {
      throw new DomainValidationError('Una comanda cobrada necesita su factura', 'invoiceId');
    }

    this.props = {
      ...this.props,
      status: 'CHARGED',
      invoiceId,
      chargedAt: now,
      chargedBy: actorId,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Devuelve a caja una comanda cuya venta se anuló (ADR-0020).
   *
   * El servicio se hizo igual: lo que estaba mal era el cobro (clienta equivocada, método de
   * pago). Dejarla «cobrada» apuntando a una factura anulada haría desaparecer el servicio
   * de caja y bloquearía volver a registrar la cita. Pendiente otra vez, se cobra bien.
   */
  reopen(now: Date, actorId: string | null): void {
    if (this.props.status !== 'CHARGED') {
      throw new InvalidStateTransitionError('Comanda', this.props.status, 'PENDING');
    }

    this.props = {
      ...this.props,
      status: 'PENDING',
      invoiceId: null,
      chargedAt: null,
      chargedBy: null,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Anula una comanda que no se va a cobrar: clienta equivocada, servicio mal elegido.
   *
   * Exige motivo porque es la única forma de que un servicio realizado salga de caja sin
   * pasar por la factura, y eso tiene que poder revisarse después.
   */
  cancel(reason: string, now: Date, actorId: string | null): void {
    this.assertPending('CANCELLED');
    const text = reason?.trim();
    if (!text) {
      throw new DomainValidationError('Indique el motivo de la anulación', 'reason');
    }

    this.props = {
      ...this.props,
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledBy: actorId,
      cancellationReason: text,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  private assertPending(target: ServiceTicketStatusValue): void {
    if (this.props.status !== 'PENDING') {
      throw new InvalidStateTransitionError('Comanda', this.props.status, target);
    }
  }
}
