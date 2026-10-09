import type { AppointmentChangeRequest, ChangeRequestStatusValue } from './change-request.entity';

export interface ChangeRequestFilter {
  readonly status?: ChangeRequestStatusValue;
  /** Ámbito `.own`: solo las solicitudes de esta profesional. */
  readonly stylistId?: string;
  readonly appointmentIds?: readonly string[];
  /** Solo las decididas desde este instante. Lo usa el aviso de «te contestaron». */
  readonly decidedSince?: Date;
}

export interface ChangeRequestRepository {
  findByIdOrFail(id: string): Promise<AppointmentChangeRequest>;
  findPendingForAppointment(appointmentId: string): Promise<AppointmentChangeRequest | null>;
  list(filter: ChangeRequestFilter, limit: number): Promise<AppointmentChangeRequest[]>;
  countPending(): Promise<number>;
  /**
   * Crea la solicitud. Si ya hay otra pendiente para la misma cita, falla con
   * `CHANGE_REQUEST_ALREADY_PENDING`: lo garantiza un índice único parcial, así que dos
   * peticiones simultáneas no pueden dejar dos pendientes.
   */
  create(request: AppointmentChangeRequest): Promise<AppointmentChangeRequest>;
  update(request: AppointmentChangeRequest): Promise<AppointmentChangeRequest>;
}

export const CHANGE_REQUEST_REPOSITORY = Symbol('ChangeRequestRepository');
