import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import {
  addCalendarDays,
  parseCalendarDay,
  type CalendarDay,
} from '../../../shared/domain/time/zoned-time';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { Percentage, TimeRange } from '../../../shared/domain/value-objects/time-range.vo';
import {
  Stylist,
  type StylistSkill,
  type StylistStatusValue,
  type WorkingBlock,
} from '../domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistFilter,
  type StylistRepository,
  type StylistSortField,
} from '../domain/stylist.repository';

/** Datos del salón que el dominio necesita y que no le pertenecen. */
export interface SalonContext {
  readonly timeZone: string;
}

export const SALON_CONTEXT = Symbol('SalonContext');

export interface CreateStylistInput {
  readonly tenantId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly displayName?: string | null;
  readonly bio?: string | null;
  readonly color?: string;
  readonly hiredAt?: Date | null;
  readonly commissionRate?: number;
  readonly userId?: string | null;
  readonly actorId: string | null;
}

@Injectable()
export class CreateStylistUseCase implements UseCase<CreateStylistInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateStylistInput): Promise<Stylist> {
    const stylist = Stylist.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      name: PersonName.create(input.firstName, input.lastName),
      email: Email.createOptional(input.email),
      phone: Phone.createOptional(input.phone),
      displayName: input.displayName ?? null,
      bio: input.bio ?? null,
      color: input.color,
      hiredAt: input.hiredAt ?? null,
      commissionRate:
        input.commissionRate === undefined ? undefined : Percentage.create(input.commissionRate),
      userId: input.userId ?? null,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const saved = await this.stylists.create(stylist);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Stylist',
      entityId: saved.id,
      after: { name: saved.name.full, commissionRate: saved.commissionRate.value },
    });

    return saved;
  }
}

export interface UpdateStylistInput {
  readonly id: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly displayName?: string | null;
  readonly bio?: string | null;
  readonly color?: string;
  readonly hiredAt?: Date | null;
  readonly commissionRate?: number;
  readonly status?: StylistStatusValue;
  readonly userId?: string | null;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateStylistUseCase implements UseCase<UpdateStylistInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: UpdateStylistInput): Promise<Stylist> {
    const now = this.clock.now();
    const stylist = await this.stylists.findByIdOrFail(input.id);

    const before = { name: stylist.name.full, status: stylist.status };

    stylist.updateProfile(
      {
        name:
          input.firstName !== undefined || input.lastName !== undefined
            ? PersonName.create(
                input.firstName ?? stylist.name.firstName,
                input.lastName ?? stylist.name.lastName,
              )
            : undefined,
        email: input.email !== undefined ? Email.createOptional(input.email) : undefined,
        phone: input.phone !== undefined ? Phone.createOptional(input.phone) : undefined,
        displayName: input.displayName,
        bio: input.bio,
        color: input.color,
        hiredAt: input.hiredAt,
        commissionRate:
          input.commissionRate === undefined ? undefined : Percentage.create(input.commissionRate),
        userId: input.userId,
      },
      now,
      input.actorId,
    );

    if (input.status !== undefined) {
      stylist.changeStatus(input.status, now, input.actorId);
    }

    const saved = await this.stylists.update(stylist);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Stylist',
      entityId: saved.id,
      before,
      after: { name: saved.name.full, status: saved.status },
    });

    return saved;
  }
}

@Injectable()
export class GetStylistUseCase implements UseCase<string, Stylist> {
  constructor(@Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository) {}

  execute(id: string): Promise<Stylist> {
    return this.stylists.findByIdOrFail(id);
  }
}

export interface SearchStylistsInput {
  readonly filter: StylistFilter;
  readonly page: PageRequest<StylistSortField>;
  readonly includeDeleted?: boolean;
}

@Injectable()
export class SearchStylistsUseCase implements UseCase<SearchStylistsInput, Page<Stylist>> {
  constructor(@Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository) {}

  execute(input: SearchStylistsInput): Promise<Page<Stylist>> {
    return this.stylists.search(input.filter, input.page, {
      includeDeleted: input.includeDeleted ?? false,
    });
  }
}

export interface StylistIdInput {
  readonly id: string;
  readonly actorId: string | null;
}

@Injectable()
export class DeleteStylistUseCase implements UseCase<StylistIdInput, void> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: StylistIdInput): Promise<void> {
    const stylist = await this.stylists.findByIdOrFail(input.id);
    await this.stylists.softDelete(input.id, input.actorId);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Stylist',
      entityId: input.id,
      before: { name: stylist.name.full },
    });
  }
}

@Injectable()
export class RestoreStylistUseCase implements UseCase<StylistIdInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: StylistIdInput): Promise<Stylist> {
    const restored = await this.stylists.restore(input.id, input.actorId);
    await this.audit.record({ action: 'RESTORE', entityType: 'Stylist', entityId: input.id });
    return restored;
  }
}

// ---------------------------------------------------------------------------
// Horario, ausencias y habilidades
// ---------------------------------------------------------------------------

export interface SetScheduleInput {
  readonly stylistId: string;
  readonly blocks: readonly { dayOfWeek: number; startMinutes: number; endMinutes: number }[];
  readonly actorId: string | null;
}

@Injectable()
export class SetStylistScheduleUseCase implements UseCase<SetScheduleInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: SetScheduleInput): Promise<Stylist> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);

    const blocks: WorkingBlock[] = input.blocks.map((block) => ({
      id: this.ids.generate(),
      dayOfWeek: block.dayOfWeek,
      startMinutes: block.startMinutes,
      endMinutes: block.endMinutes,
    }));

    stylist.replaceSchedule(blocks, this.clock.now(), input.actorId);
    const saved = await this.stylists.update(stylist);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Stylist',
      entityId: saved.id,
      metadata: { field: 'schedule', weeklyMinutes: saved.weeklyMinutes },
    });

    return saved;
  }
}

export interface AddTimeOffInput {
  readonly stylistId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly reason?: string | null;
  readonly actorId: string | null;
}

@Injectable()
export class AddTimeOffUseCase implements UseCase<AddTimeOffInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: AddTimeOffInput): Promise<Stylist> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);

    stylist.addTimeOff(
      {
        id: this.ids.generate(),
        range: TimeRange.create(input.startsAt, input.endsAt),
        reason: input.reason ?? null,
      },
      this.clock.now(),
      input.actorId,
    );

    const saved = await this.stylists.update(stylist);

    // Se audita porque una ausencia puede dejar citas ya reservadas fuera del horario.
    // Quien la registra debe quedar identificado.
    await this.audit.record({
      action: 'CREATE',
      entityType: 'StylistTimeOff',
      entityId: saved.id,
      after: {
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        reason: input.reason ?? null,
      },
    });

    return saved;
  }
}

export interface RemoveTimeOffInput {
  readonly stylistId: string;
  readonly timeOffId: string;
  readonly actorId: string | null;
}

@Injectable()
export class RemoveTimeOffUseCase implements UseCase<RemoveTimeOffInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: RemoveTimeOffInput): Promise<Stylist> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);

    stylist.removeTimeOff(input.timeOffId, this.clock.now(), input.actorId);
    const saved = await this.stylists.update(stylist);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'StylistTimeOff',
      entityId: input.timeOffId,
    });

    return saved;
  }
}

export interface SetSkillsInput {
  readonly stylistId: string;
  readonly skills: readonly {
    serviceId: string;
    durationMinutes?: number | null;
    commissionRate?: number | null;
  }[];
  readonly actorId: string | null;
}

@Injectable()
export class SetStylistSkillsUseCase implements UseCase<SetSkillsInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: SetSkillsInput): Promise<Stylist> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);

    const skills: StylistSkill[] = input.skills.map((skill) => ({
      serviceId: skill.serviceId,
      durationMinutes: skill.durationMinutes ?? null,
      commissionRate:
        skill.commissionRate === null || skill.commissionRate === undefined
          ? null
          : Percentage.create(skill.commissionRate),
    }));

    stylist.replaceSkills(skills, this.clock.now(), input.actorId);
    const saved = await this.stylists.update(stylist);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Stylist',
      entityId: saved.id,
      metadata: { field: 'skills', count: skills.length },
    });

    return saved;
  }
}

// ---------------------------------------------------------------------------
// Disponibilidad
// ---------------------------------------------------------------------------

export interface WorkingHoursInput {
  readonly stylistId: string;
  /** Día ISO `YYYY-MM-DD` en la zona del salón. */
  readonly from: string;
  readonly to: string;
}

export interface DayWorkingHours {
  readonly date: string;
  readonly intervals: readonly { startsAt: string; endsAt: string }[];
  readonly totalMinutes: number;
}

/**
 * Horario trabajable de un profesional en un rango de días.
 *
 * Devuelve el horario **ya descontadas las ausencias**, pero sin descontar las citas: es
 * la capacidad, no la disponibilidad. Los huecos libres los calcula el módulo de agenda,
 * que es quien conoce las reservas.
 *
 * Separarlo así evita que este módulo dependa del de citas —lo que crearía un ciclo— y
 * deja la responsabilidad donde está la información.
 */
@Injectable()
export class GetStylistWorkingHoursUseCase implements UseCase<
  WorkingHoursInput,
  DayWorkingHours[]
> {
  /** Tope de días por consulta: evita que una petición pida un año entero por descuido. */
  private static readonly MAX_DAYS = 62;

  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
  ) {}

  async execute(input: WorkingHoursInput): Promise<DayWorkingHours[]> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);

    const from = parseCalendarDay(input.from);
    const to = parseCalendarDay(input.to);
    const days = this.enumerateDays(from, to);

    return days.map((day) => {
      const intervals = stylist.workingIntervalsOn(day, this.salon.timeZone);

      return {
        date: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
        intervals: intervals.map((interval) => ({
          startsAt: interval.startsAt.toISOString(),
          endsAt: interval.endsAt.toISOString(),
        })),
        totalMinutes: intervals.reduce((total, interval) => total + interval.durationMinutes, 0),
      };
    });
  }

  private enumerateDays(from: CalendarDay, to: CalendarDay): CalendarDay[] {
    const days: CalendarDay[] = [];
    let cursor = from;

    const limit = Date.UTC(to.year, to.month - 1, to.day);

    while (Date.UTC(cursor.year, cursor.month - 1, cursor.day) <= limit) {
      days.push(cursor);
      if (days.length > GetStylistWorkingHoursUseCase.MAX_DAYS) {
        throw new Error(`El rango no puede superar ${GetStylistWorkingHoursUseCase.MAX_DAYS} días`);
      }
      cursor = addCalendarDays(cursor, 1);
    }

    return days;
  }
}
