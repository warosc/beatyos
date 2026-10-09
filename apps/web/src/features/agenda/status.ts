import type { AppointmentStatus } from './types';

/**
 * Cómo se ve cada estado en la agenda.
 *
 * El color de la cita es el de la profesional —es lo que se busca de un vistazo en una
 * parrilla con seis columnas—; el estado va en la etiqueta y en el tratamiento del bloque:
 * lo terminado se apaga, lo cancelado se tacha, lo que está pasando ahora se resalta.
 */
export const STATUS_META: Record<
  AppointmentStatus,
  { label: string; badge: string; block: string; dot: string }
> = {
  SCHEDULED: {
    label: 'Pendiente',
    badge: 'bg-warning/15 text-warning',
    block: '',
    dot: 'bg-warning',
  },
  CONFIRMED: {
    label: 'Confirmada',
    badge: 'bg-success/15 text-success',
    block: '',
    dot: 'bg-success',
  },
  IN_PROGRESS: {
    label: 'En curso',
    badge: 'bg-primary/15 text-primary',
    block: 'ring-2 ring-primary',
    dot: 'bg-primary',
  },
  COMPLETED: {
    label: 'Atendida',
    badge: 'bg-muted text-muted-foreground',
    block: 'opacity-60',
    dot: 'bg-muted-foreground',
  },
  CANCELLED: {
    label: 'Cancelada',
    badge: 'bg-muted text-muted-foreground',
    block: 'opacity-50 line-through',
    dot: 'bg-muted-foreground',
  },
  NO_SHOW: {
    label: 'No vino',
    badge: 'bg-danger/15 text-danger',
    block: 'opacity-60',
    dot: 'bg-danger',
  },
};

export const statusMeta = (status: string) =>
  STATUS_META[status as AppointmentStatus] ?? STATUS_META.SCHEDULED;

/** Ocupan sillón: lo que la parrilla pinta siempre. Lo demás, según el filtro. */
export const isActive = (status: string) =>
  status === 'SCHEDULED' || status === 'CONFIRMED' || status === 'IN_PROGRESS';

/** Motivos de cancelación habituales: un toque en lugar de escribir en el mostrador. */
export const CANCEL_REASONS = [
  'La clienta avisó que no puede venir',
  'La clienta se enfermó',
  'Reprogramará más adelante',
  'Error al agendar',
  'Ausencia de la profesional',
];
