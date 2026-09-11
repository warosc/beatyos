import { DomainValidationError } from '../../../shared/domain/errors';
import { TimeRange } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Cálculo de huecos libres.
 *
 * Es un **servicio de dominio** y no un método de una entidad porque la respuesta necesita
 * dos agregados a la vez —el horario del profesional y sus citas— y no pertenece a
 * ninguno de los dos. Meterlo en `Stylist` obligaría a que el profesional conociera las
 * citas; meterlo en `Appointment`, a que una cita conociera el horario. Ambas opciones
 * crean el acoplamiento que la arquitectura evita.
 *
 * No tiene estado ni dependencias: entra información, sale información. Eso lo hace
 * trivial de probar y explica por qué casi todas las reglas difíciles de la agenda se
 * comprueban aquí.
 */

export interface SlotSearchOptions {
  /** Tiempo que hay que encajar, margen de limpieza incluido. */
  readonly durationMinutes: number;
  /**
   * Cada cuántos minutos se ofrece un hueco.
   *
   * Con 15, una jornada libre de 9 a 20 produce huecos a las 9:00, 9:15, 9:30… en lugar
   * de uno solo a las 9:00. Es lo que espera quien mira una parrilla de reservas.
   */
  readonly granularityMinutes?: number;
  /** No se ofrecen huecos antes de este instante. Normalmente, «ahora». */
  readonly notBefore?: Date;
  /** Antelación mínima para reservar. Da margen a preparar el material. */
  readonly minimumNoticeMinutes?: number;
}

export const AvailabilityService = {
  /**
   * Resta los intervalos ocupados de los disponibles.
   *
   * Un intervalo ocupado puede partir uno libre en dos, así que no basta con descartar:
   * hay que recortar. Es el mismo problema que las ausencias sobre el horario, y por eso
   * la operación vive aquí una sola vez en lugar de repetirse en ambos sitios.
   */
  subtract(available: readonly TimeRange[], busy: readonly TimeRange[]): TimeRange[] {
    let remaining = [...available];

    for (const occupied of busy) {
      const next: TimeRange[] = [];

      for (const interval of remaining) {
        if (!interval.overlaps(occupied)) {
          next.push(interval);
          continue;
        }

        if (interval.startsAt < occupied.startsAt) {
          next.push(TimeRange.create(interval.startsAt, occupied.startsAt));
        }
        if (interval.endsAt > occupied.endsAt) {
          next.push(TimeRange.create(occupied.endsAt, interval.endsAt));
        }
      }

      remaining = next;
    }

    return remaining.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  },

  /**
   * Funde intervalos que se solapan o se tocan.
   *
   * Dos citas consecutivas —10:00-11:00 y 11:00-12:00— dejan un único bloque ocupado de
   * 10 a 12. Sin fundirlas, el recorte produciría intervalos libres de duración cero
   * entre ellas, que después habría que filtrar.
   */
  merge(ranges: readonly TimeRange[]): TimeRange[] {
    if (ranges.length === 0) return [];

    const sorted = [...ranges].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const merged: TimeRange[] = [sorted[0]];

    for (const range of sorted.slice(1)) {
      const last = merged[merged.length - 1];

      // `<=` y no `<`: los intervalos que solo se tocan por el extremo también se funden.
      if (range.startsAt.getTime() <= last.endsAt.getTime()) {
        merged[merged.length - 1] = TimeRange.create(
          last.startsAt,
          new Date(Math.max(last.endsAt.getTime(), range.endsAt.getTime())),
        );
      } else {
        merged.push(range);
      }
    }

    return merged;
  },

  /**
   * Huecos concretos en los que cabe un servicio.
   *
   * Devuelve **momentos de inicio posibles**, no bloques libres: es lo que la interfaz
   * necesita para pintar una parrilla de horas seleccionables.
   */
  findSlots(
    workingIntervals: readonly TimeRange[],
    busy: readonly TimeRange[],
    options: SlotSearchOptions,
  ): TimeRange[] {
    const { durationMinutes } = options;
    const granularity = options.granularityMinutes ?? 15;

    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new DomainValidationError(
        'La duración debe ser un número entero de minutos mayor que cero',
        'durationMinutes',
      );
    }
    if (!Number.isInteger(granularity) || granularity <= 0) {
      throw new DomainValidationError(
        'La granularidad debe ser un número entero de minutos mayor que cero',
        'granularityMinutes',
      );
    }

    const earliest = AvailabilityService.earliestBookableInstant(options);
    const free = AvailabilityService.subtract(workingIntervals, AvailabilityService.merge(busy));

    const slots: TimeRange[] = [];
    const durationMs = durationMinutes * 60_000;
    const stepMs = granularity * 60_000;

    for (const window of free) {
      // Los huecos se alinean a la rejilla horaria del salón —en punto, y cuarto, y
      // media…—, no al final arbitrario de la cita anterior. Una parrilla con horas del
      // tipo «11:07» es inservible para quien atiende el teléfono.
      let cursor = AvailabilityService.alignToGrid(window.startsAt, stepMs);

      if (earliest && cursor.getTime() < earliest.getTime()) {
        cursor = AvailabilityService.alignToGrid(earliest, stepMs);
      }

      while (cursor.getTime() + durationMs <= window.endsAt.getTime()) {
        slots.push(TimeRange.fromDuration(cursor, durationMinutes));
        cursor = new Date(cursor.getTime() + stepMs);
      }
    }

    return slots;
  },

  /** `true` si el intervalo cabe entero en algún tramo libre. */
  fitsIn(
    candidate: TimeRange,
    workingIntervals: readonly TimeRange[],
    busy: readonly TimeRange[],
  ): boolean {
    const free = AvailabilityService.subtract(workingIntervals, AvailabilityService.merge(busy));
    return free.some((window) => candidate.isWithin(window));
  },

  /** Minutos libres totales. Alimenta el indicador de ocupación de los informes. */
  freeMinutes(workingIntervals: readonly TimeRange[], busy: readonly TimeRange[]): number {
    return AvailabilityService.subtract(workingIntervals, AvailabilityService.merge(busy)).reduce(
      (total, interval) => total + interval.durationMinutes,
      0,
    );
  },

  /**
   * Porcentaje de ocupación sobre el tiempo trabajable.
   *
   * Devuelve 0 si no hay horario: un profesional que hoy no trabaja no está «ocupado al
   * 0%», simplemente no aplica, y un salón vacío no debería salir con divisiones por cero
   * en el panel.
   */
  occupancyRate(workingIntervals: readonly TimeRange[], busy: readonly TimeRange[]): number {
    const capacity = workingIntervals.reduce(
      (total, interval) => total + interval.durationMinutes,
      0,
    );
    if (capacity === 0) return 0;

    const free = AvailabilityService.freeMinutes(workingIntervals, busy);
    return Math.round(((capacity - free) / capacity) * 10_000) / 100;
  },

  /** Redondea hacia arriba al siguiente múltiplo de la rejilla. */
  alignToGrid(instant: Date, stepMs: number): Date {
    const time = instant.getTime();
    const remainder = time % stepMs;
    return remainder === 0 ? new Date(time) : new Date(time + (stepMs - remainder));
  },

  earliestBookableInstant(options: SlotSearchOptions): Date | null {
    if (!options.notBefore) return null;

    const noticeMs = (options.minimumNoticeMinutes ?? 0) * 60_000;
    return new Date(options.notBefore.getTime() + noticeMs);
  },
};
