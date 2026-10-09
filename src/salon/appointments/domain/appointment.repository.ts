import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { TimeRange } from '../../../shared/domain/value-objects/time-range.vo';
import type { Appointment, AppointmentStatusValue } from './appointment.entity';

export interface AppointmentFilter {
  readonly stylistId?: string;
  readonly clientId?: string;
  readonly status?: AppointmentStatusValue;
  /** Solo las que ocupan sillón. Es lo que pinta el calendario. */
  readonly onlyBlocking?: boolean;
  readonly from?: Date;
  readonly to?: Date;
  readonly search?: string;
}

export type AppointmentSortField = 'startsAt' | 'createdAt' | 'status';

export interface AppointmentRepository extends SearchableRepository<
  Appointment,
  AppointmentFilter,
  AppointmentSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Appointment>;

  /**
   * Citas que ocupan el sillón de un profesional en un intervalo.
   *
   * Es la consulta que alimenta el cálculo de huecos y la comprobación previa al
   * reservar. Devuelve **solo** las que bloquean —pendiente, confirmada, en curso—: una
   * cancelada libera el hueco, y contarla dejaría la agenda artificialmente llena.
   *
   * `excludeAppointmentId` sirve al reprogramar: la propia cita que se está moviendo no
   * debe contarse como obstáculo de sí misma.
   */
  findBlockingInRange(
    stylistId: string,
    range: TimeRange,
    excludeAppointmentId?: string,
  ): Promise<Appointment[]>;

  /** Agenda del día para varios profesionales, en una sola consulta. */
  findForCalendar(range: TimeRange, stylistIds?: readonly string[]): Promise<Appointment[]>;

  search(
    filter: AppointmentFilter,
    page: PageRequest<AppointmentSortField>,
    options?: QueryOptions,
  ): Promise<Page<Appointment>>;

  create(appointment: Appointment): Promise<Appointment>;
  update(appointment: Appointment): Promise<Appointment>;
}

export const APPOINTMENT_REPOSITORY = Symbol('AppointmentRepository');
