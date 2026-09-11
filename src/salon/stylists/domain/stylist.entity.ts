import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';
import {
  addCalendarDays,
  dayOfWeekInZone,
  formatMinutes,
  instantToCalendarDay,
  zonedTimeToInstant,
  type CalendarDay,
  type MinutesFromMidnight,
} from '../../../shared/domain/time/zoned-time';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { Percentage, TimeRange } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Profesional del salón.
 *
 * Es el agregado que decide **cuándo se puede reservar**. Concentra tres cosas que en
 * conjunto definen su disponibilidad y que por separado no significan nada:
 *
 * - el **horario semanal** recurrente («los martes de 10 a 20»),
 * - las **ausencias** puntuales (vacaciones, formación, baja),
 * - las **habilidades**: qué servicios sabe hacer y en cuánto tiempo.
 *
 * Tenerlas juntas en un agregado no es dogma: es que la pregunta «¿está libre el martes a
 * las 11?» necesita las tres a la vez, y repartirlas obligaría a que quien la formule
 * conozca el orden correcto de aplicarlas.
 */

export type StylistStatusValue = 'ACTIVE' | 'INACTIVE' | 'ON_LEAVE';

/** Tramo de trabajo recurrente. `dayOfWeek` va de 0 (domingo) a 6 (sábado). */
export interface WorkingBlock {
  readonly id: string;
  readonly dayOfWeek: number;
  readonly startMinutes: MinutesFromMidnight;
  readonly endMinutes: MinutesFromMidnight;
}

/** Ausencia puntual. Bloquea la agenda por completo mientras dura. */
export interface TimeOffPeriod {
  readonly id: string;
  readonly range: TimeRange;
  readonly reason: string | null;
}

/**
 * Servicio que el profesional sabe hacer.
 *
 * `durationMinutes` y `commissionRate` son sobreescrituras opcionales: una estilista
 * veterana puede tardar 30 minutos en un corte para el que el catálogo reserva 45, y esa
 * diferencia debe reflejarse en la agenda o el salón pierde huecos vendibles todos los días.
 */
export interface StylistSkill {
  readonly serviceId: string;
  readonly durationMinutes: number | null;
  readonly commissionRate: Percentage | null;
}

export interface StylistProps {
  readonly tenantId: string;
  /** Cuenta de acceso asociada. Opcional: no todo profesional usa el sistema. */
  readonly userId: string | null;
  readonly name: PersonName;
  readonly email: Email | null;
  readonly phone: Phone | null;
  readonly displayName: string | null;
  readonly bio: string | null;
  /** Color con el que se pinta en el calendario. */
  readonly color: string;
  readonly status: StylistStatusValue;
  readonly hiredAt: Date | null;
  readonly commissionRate: Percentage;
  readonly schedule: readonly WorkingBlock[];
  readonly timeOff: readonly TimeOffPeriod[];
  readonly skills: readonly StylistSkill[];
  readonly audit: AuditMetadata;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export class Stylist extends AggregateRoot {
  private constructor(
    id: string,
    private props: StylistProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    name: PersonName;
    userId?: string | null;
    email?: Email | null;
    phone?: Phone | null;
    displayName?: string | null;
    bio?: string | null;
    color?: string;
    hiredAt?: Date | null;
    commissionRate?: Percentage;
    now: Date;
    actorId: string | null;
  }): Stylist {
    const color = params.color ?? '#8B5CF6';
    if (!HEX_COLOR.test(color)) {
      throw new DomainValidationError(
        `El color debe ser hexadecimal de 6 dígitos, se recibió "${color}"`,
        'color',
      );
    }

    return new Stylist(params.id, {
      tenantId: params.tenantId,
      userId: params.userId ?? null,
      name: params.name,
      email: params.email ?? null,
      phone: params.phone ?? null,
      displayName: params.displayName ?? null,
      bio: params.bio ?? null,
      color,
      status: 'ACTIVE',
      hiredAt: params.hiredAt ?? null,
      commissionRate: params.commissionRate ?? Percentage.zero(),
      schedule: [],
      timeOff: [],
      skills: [],
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

  static rehydrate(id: string, props: StylistProps): Stylist {
    return new Stylist(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get userId(): string | null {
    return this.props.userId;
  }
  get name(): PersonName {
    return this.props.name;
  }
  get email(): Email | null {
    return this.props.email;
  }
  get phone(): Phone | null {
    return this.props.phone;
  }
  get displayName(): string {
    return this.props.displayName ?? this.props.name.firstName;
  }
  get bio(): string | null {
    return this.props.bio;
  }
  get color(): string {
    return this.props.color;
  }
  get status(): StylistStatusValue {
    return this.props.status;
  }
  get hiredAt(): Date | null {
    return this.props.hiredAt;
  }
  get commissionRate(): Percentage {
    return this.props.commissionRate;
  }
  get schedule(): readonly WorkingBlock[] {
    return this.props.schedule;
  }
  get timeOff(): readonly TimeOffPeriod[] {
    return this.props.timeOff;
  }
  get skills(): readonly StylistSkill[] {
    return this.props.skills;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * Sella la baja lógica (ADR-0004).
   *
   * No borra: marca. El repositorio persiste el sello, pero la decisión pertenece al
   * dominio —es él quien sabe qué significa que algo esté dado de baja— y tenerla aquí
   * permite que los dobles en memoria de los tests reproduzcan el comportamiento real.
   */
  markDeleted(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  /** Deshace la baja lógica. */
  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  /** Solo un profesional activo admite reservas nuevas. */
  isBookable(): boolean {
    return this.props.status === 'ACTIVE' && !this.isDeleted;
  }

  // -- Perfil ---------------------------------------------------------------

  updateProfile(
    changes: {
      name?: PersonName;
      email?: Email | null;
      phone?: Phone | null;
      displayName?: string | null;
      bio?: string | null;
      color?: string;
      hiredAt?: Date | null;
      commissionRate?: Percentage;
      userId?: string | null;
    },
    now: Date,
    actorId: string | null,
  ): void {
    if (changes.color !== undefined && !HEX_COLOR.test(changes.color)) {
      throw new DomainValidationError('El color debe ser hexadecimal de 6 dígitos', 'color');
    }

    this.props = {
      ...this.props,
      name: changes.name ?? this.props.name,
      email: changes.email !== undefined ? changes.email : this.props.email,
      phone: changes.phone !== undefined ? changes.phone : this.props.phone,
      displayName: changes.displayName !== undefined ? changes.displayName : this.props.displayName,
      bio: changes.bio !== undefined ? changes.bio : this.props.bio,
      color: changes.color ?? this.props.color,
      hiredAt: changes.hiredAt !== undefined ? changes.hiredAt : this.props.hiredAt,
      commissionRate: changes.commissionRate ?? this.props.commissionRate,
      userId: changes.userId !== undefined ? changes.userId : this.props.userId,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  changeStatus(status: StylistStatusValue, now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      status,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  // -- Horario semanal ------------------------------------------------------

  /**
   * Reemplaza el horario semanal completo.
   *
   * Se sustituye entero en lugar de aplicar diferencias: un horario es una unidad con
   * sentido —«mi semana»— y editarlo tramo a tramo abre estados intermedios incoherentes,
   * como un descanso de comida que se solapa con la tarde porque el orden de las
   * operaciones no fue el previsto.
   */
  replaceSchedule(blocks: readonly WorkingBlock[], now: Date, actorId: string | null): void {
    for (const block of blocks) {
      Stylist.assertValidBlock(block);
    }

    // Los tramos del mismo día no pueden solaparse. Dos bloques superpuestos no son un
    // error inofensivo: harían que el mismo hueco se ofreciera dos veces.
    for (const dayOfWeek of new Set(blocks.map((block) => block.dayOfWeek))) {
      const sameDay = blocks
        .filter((block) => block.dayOfWeek === dayOfWeek)
        .sort((a, b) => a.startMinutes - b.startMinutes);

      for (let i = 1; i < sameDay.length; i += 1) {
        if (sameDay[i].startMinutes < sameDay[i - 1].endMinutes) {
          throw new BusinessRuleViolationError(
            'SCHEDULE_BLOCKS_OVERLAP',
            `Los tramos de horario se solapan: ${formatMinutes(sameDay[i - 1].startMinutes)}-${formatMinutes(sameDay[i - 1].endMinutes)} y ${formatMinutes(sameDay[i].startMinutes)}-${formatMinutes(sameDay[i].endMinutes)}`,
            { dayOfWeek },
          );
        }
      }
    }

    this.props = {
      ...this.props,
      schedule: [...blocks],
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Minutos de trabajo semanales. Alimenta el reparto de carga y el coste de personal. */
  get weeklyMinutes(): number {
    return this.props.schedule.reduce(
      (total, block) => total + (block.endMinutes - block.startMinutes),
      0,
    );
  }

  // -- Ausencias ------------------------------------------------------------

  addTimeOff(period: TimeOffPeriod, now: Date, actorId: string | null): void {
    const overlapping = this.props.timeOff.find((existing) =>
      existing.range.overlaps(period.range),
    );

    if (overlapping) {
      throw new BusinessRuleViolationError(
        'TIME_OFF_OVERLAP',
        'Ya existe una ausencia registrada que se solapa con ese periodo',
        { existingId: overlapping.id },
      );
    }

    this.props = {
      ...this.props,
      timeOff: [...this.props.timeOff, period],
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  removeTimeOff(timeOffId: string, now: Date, actorId: string | null): void {
    const remaining = this.props.timeOff.filter((period) => period.id !== timeOffId);

    if (remaining.length === this.props.timeOff.length) {
      throw new BusinessRuleViolationError('TIME_OFF_NOT_FOUND', 'La ausencia indicada no existe', {
        timeOffId,
      });
    }

    this.props = {
      ...this.props,
      timeOff: remaining,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  isOnLeaveDuring(range: TimeRange): boolean {
    return this.props.timeOff.some((period) => period.range.overlaps(range));
  }

  // -- Habilidades ----------------------------------------------------------

  replaceSkills(skills: readonly StylistSkill[], now: Date, actorId: string | null): void {
    const seen = new Set<string>();
    for (const skill of skills) {
      if (seen.has(skill.serviceId)) {
        throw new DomainValidationError(
          'Un servicio no puede aparecer dos veces en las habilidades',
          'skills',
        );
      }
      seen.add(skill.serviceId);

      if (skill.durationMinutes !== null && skill.durationMinutes <= 0) {
        throw new DomainValidationError(
          'La duración personalizada debe ser mayor que cero',
          'durationMinutes',
        );
      }
    }

    this.props = {
      ...this.props,
      skills: [...skills],
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  canPerform(serviceId: string): boolean {
    // Sin habilidades declaradas se asume que puede hacer de todo. Es el comportamiento
    // que espera un salón pequeño recién dado de alta, donde exigir la matriz completa de
    // servicio×profesional antes de poder agendar la primera cita sería un estorbo.
    if (this.props.skills.length === 0) return true;
    return this.props.skills.some((skill) => skill.serviceId === serviceId);
  }

  /** Duración efectiva de un servicio para este profesional, con su ajuste si lo tiene. */
  durationFor(serviceId: string, catalogDuration: number): number {
    const skill = this.props.skills.find((entry) => entry.serviceId === serviceId);
    return skill?.durationMinutes ?? catalogDuration;
  }

  /** Comisión efectiva: la del servicio si la tiene ajustada, si no la general suya. */
  commissionFor(serviceId: string, serviceCommission: Percentage | null): Percentage {
    const skill = this.props.skills.find((entry) => entry.serviceId === serviceId);
    return skill?.commissionRate ?? serviceCommission ?? this.props.commissionRate;
  }

  // -- Disponibilidad -------------------------------------------------------

  /**
   * Tramos en los que el profesional trabaja un día concreto, ya como instantes absolutos.
   *
   * Aquí es donde el horario recurrente —expresado en hora local del salón— se convierte
   * en momentos reales del calendario. La zona horaria es obligatoria justamente para que
   * nadie pueda olvidarla: usar la del servidor desplazaría toda la agenda una o dos horas
   * según la época del año.
   *
   * Se descuentan las ausencias, de modo que lo devuelto es tiempo **realmente
   * trabajable**, no el horario teórico.
   */
  workingIntervalsOn(day: CalendarDay, timeZone: string): TimeRange[] {
    if (!this.isBookable()) return [];

    // El día de la semana se calcula a partir del propio día de calendario, sin pasar por
    // ningún instante, para que no dependa de la hora a la que se pregunte.
    const reference = zonedTimeToInstant(day, 12 * 60, timeZone);
    const dayOfWeek = dayOfWeekInZone(reference, timeZone);

    const intervals = this.props.schedule
      .filter((block) => block.dayOfWeek === dayOfWeek)
      .map((block) =>
        TimeRange.create(
          zonedTimeToInstant(day, block.startMinutes, timeZone),
          // Un tramo que termina a medianoche se expresa como 1440 y cae ya en el día
          // siguiente: hay que convertirlo con la fecha correcta o la conversión falla.
          block.endMinutes === 1440
            ? zonedTimeToInstant(addCalendarDays(day, 1), 0, timeZone)
            : zonedTimeToInstant(day, block.endMinutes, timeZone),
        ),
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    return this.subtractTimeOff(intervals);
  }

  /**
   * Resta las ausencias de los tramos de trabajo.
   *
   * Una ausencia puede partir un tramo en dos —una formación de 12 a 14 en una jornada de
   * 9 a 20 deja libres 9-12 y 14-20—, así que no basta con descartar los tramos
   * afectados: hay que recortarlos.
   */
  private subtractTimeOff(intervals: TimeRange[]): TimeRange[] {
    let remaining = intervals;

    for (const absence of this.props.timeOff) {
      const next: TimeRange[] = [];

      for (const interval of remaining) {
        if (!interval.overlaps(absence.range)) {
          next.push(interval);
          continue;
        }

        // Trozo anterior a la ausencia, si queda algo.
        if (interval.startsAt < absence.range.startsAt) {
          next.push(TimeRange.create(interval.startsAt, absence.range.startsAt));
        }
        // Trozo posterior, si queda algo.
        if (interval.endsAt > absence.range.endsAt) {
          next.push(TimeRange.create(absence.range.endsAt, interval.endsAt));
        }
      }

      remaining = next;
    }

    return remaining;
  }

  /** `true` si el intervalo cabe entero dentro de un solo tramo de trabajo. */
  isWithinWorkingHours(range: TimeRange, timeZone: string): boolean {
    const day = instantToCalendarDay(range.startsAt, timeZone);

    // Se miran también los tramos del día anterior: un turno que cruza la medianoche
    // pertenece al día en que empezó.
    const candidates = [
      ...this.workingIntervalsOn(addCalendarDays(day, -1), timeZone),
      ...this.workingIntervalsOn(day, timeZone),
    ];

    return candidates.some((interval) => range.isWithin(interval));
  }

  private static assertValidBlock(block: WorkingBlock): void {
    if (!Number.isInteger(block.dayOfWeek) || block.dayOfWeek < 0 || block.dayOfWeek > 6) {
      throw new DomainValidationError(
        `El día de la semana debe estar entre 0 (domingo) y 6 (sábado), se recibió ${block.dayOfWeek}`,
        'dayOfWeek',
      );
    }
    if (block.startMinutes < 0 || block.endMinutes > 1440) {
      throw new DomainValidationError('El tramo debe estar dentro del día', 'schedule');
    }
    if (block.endMinutes <= block.startMinutes) {
      throw new DomainValidationError(
        'La hora de fin del tramo debe ser posterior a la de inicio',
        'endMinutes',
      );
    }
  }
}
