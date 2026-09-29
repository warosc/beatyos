import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { ServiceTicket, ServiceTicketStatusValue } from './service-ticket.entity';

export interface ServiceTicketFilter {
  readonly stylistId?: string;
  readonly status?: ServiceTicketStatusValue;
  readonly from?: Date;
  readonly to?: Date;
}

export type ServiceTicketSortField = 'createdAt';

export interface ServiceTicketRepository extends SearchableRepository<
  ServiceTicket,
  ServiceTicketFilter,
  ServiceTicketSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<ServiceTicket>;

  /** Comanda no anulada de una cita. Una cita se declara realizada una sola vez. */
  findActiveByAppointmentId(appointmentId: string): Promise<ServiceTicket | null>;

  search(
    filter: ServiceTicketFilter,
    page: PageRequest<ServiceTicketSortField>,
    options?: QueryOptions,
  ): Promise<Page<ServiceTicket>>;

  create(ticket: ServiceTicket): Promise<ServiceTicket>;

  /**
   * Persiste el cambio de estado **solo si la comanda seguía pendiente** en la base.
   *
   * Es la defensa frente a dos cajas cobrando la misma comanda a la vez: ambas la leen
   * pendiente, pero la segunda escritura no encuentra fila que actualizar y lanza
   * `SERVICE_TICKET_NOT_PENDING`, lo que revierte también su factura.
   */
  update(ticket: ServiceTicket): Promise<ServiceTicket>;
}

export const SERVICE_TICKET_REPOSITORY = Symbol('ServiceTicketRepository');
