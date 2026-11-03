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
import { USER_REPOSITORY, type UserRepository } from '../../../core/users/domain/user.repository';
import type { User } from '../../../core/users/domain/user.entity';
import { BusinessRuleViolationError } from '../../../shared/domain/errors';
import {
  UNIT_OF_WORK,
  type Page,
  type PageRequest,
  type UnitOfWork,
} from '../../../shared/domain/ports/repository.port';
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
  blocksRetirement,
  STYLIST_OFFBOARDING,
  type StylistOffboarding,
  type StylistPendingWork,
} from '../domain/stylist-offboarding.ports';
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
  readonly productCommissionRate?: number;
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
      productCommissionRate:
        input.productCommissionRate === undefined
          ? undefined
          : Percentage.create(input.productCommissionRate),
      userId: input.userId ?? null,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const saved = await this.stylists.create(stylist);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Stylist',
      entityId: saved.id,
      after: {
        name: saved.name.full,
        commissionRate: saved.commissionRate.value,
        productCommissionRate: saved.productCommissionRate.value,
      },
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
  readonly productCommissionRate?: number;
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

    const before = {
      name: stylist.name.full,
      status: stylist.status,
      commissionRate: stylist.commissionRate.value,
      productCommissionRate: stylist.productCommissionRate.value,
    };

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
        productCommissionRate:
          input.productCommissionRate === undefined
            ? undefined
            : Percentage.create(input.productCommissionRate),
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
      after: {
        name: saved.name.full,
        status: saved.status,
        commissionRate: saved.commissionRate.value,
        productCommissionRate: saved.productCommissionRate.value,
      },
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

// ---------------------------------------------------------------------------
// Baja de una profesional (ADR-0027)
// ---------------------------------------------------------------------------

export interface StylistRetirementCheck {
  readonly stylist: Stylist;
  readonly pendingWork: StylistPendingWork;
  /** `false` si se le puede dar de baja ya. */
  readonly blocked: boolean;
  readonly account: {
    /** Tiene cuenta de acceso al sistema. */
    readonly linked: boolean;
    /** Su acceso se desactivará con la baja. */
    readonly willBeDeactivated: boolean;
  };
}

/**
 * La cuenta de acceso de la profesional y si la baja debe apagarla.
 *
 * Se apaga si está activa, salvo que sea de una dueña: dar de baja su ficha de profesional
 * (deja de atender) no puede dejar al salón sin quien lo administra.
 */
const accountOf = async (
  users: UserRepository,
  stylist: Stylist,
): Promise<{ user: User | null; linked: boolean; willBeDeactivated: boolean }> => {
  if (!stylist.userId) return { user: null, linked: false, willBeDeactivated: false };
  const user = await users.findById(stylist.userId);
  return {
    user,
    linked: true,
    willBeDeactivated: !!user && user.isActive() && !user.roleCodes.includes('OWNER'),
  };
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** «2 citas pendientes, 1 comanda sin cobrar y 1 turno en curso». */
const describePending = (work: StylistPendingWork): string => {
  const parts = [
    work.appointments.total
      ? plural(work.appointments.total, 'cita pendiente', 'citas pendientes')
      : null,
    work.pendingTickets.total
      ? plural(work.pendingTickets.total, 'comanda sin cobrar', 'comandas sin cobrar')
      : null,
    work.activeQueueTurns.length
      ? plural(work.activeQueueTurns.length, 'turno en curso', 'turnos en curso')
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`
    : (parts[0] ?? '');
};

/**
 * Qué pasaría al dar de baja a una profesional: lo que lo impide y qué le pasa a su acceso.
 *
 * Existe aparte de la baja porque la pantalla necesita la **lista** de lo pendiente para
 * que la dueña lo resuelva, y los errores de la API solo llevan código y mensaje.
 */
@Injectable()
export class CheckStylistRetirementUseCase implements UseCase<
  { id: string },
  StylistRetirementCheck
> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(STYLIST_OFFBOARDING) private readonly offboarding: StylistOffboarding,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: { id: string }): Promise<StylistRetirementCheck> {
    const stylist = await this.stylists.findByIdOrFail(input.id);
    const [pendingWork, account] = await Promise.all([
      this.offboarding.pendingWorkOf(stylist.id, this.clock.now()),
      accountOf(this.users, stylist),
    ]);
    return {
      stylist,
      pendingWork,
      blocked: blocksRetirement(pendingWork),
      account: { linked: account.linked, willBeDeactivated: account.willBeDeactivated },
    };
  }
}

/**
 * Da de baja a una profesional: deja de aparecer en la agenda, la caja, la cola y las metas,
 * y su acceso al sistema se apaga. Sus ventas, citas y comisiones pasadas se conservan.
 *
 * No se puede mientras tenga citas por atender, comandas sin cobrar o turnos en curso: hay
 * que reasignarlos o cerrarlos antes. Las clientas en espera que la pidieron pasan a la fila
 * general en la misma transacción. Todo va junto: o queda dada de baja con su acceso
 * apagado, o no cambia nada.
 */
@Injectable()
export class DeleteStylistUseCase implements UseCase<StylistIdInput, void> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(STYLIST_OFFBOARDING) private readonly offboarding: StylistOffboarding,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: StylistIdInput): Promise<void> {
    await this.uow.execute(async () => {
      const stylist = await this.stylists.findByIdOrFail(input.id);
      const now = this.clock.now();

      const work = await this.offboarding.pendingWorkOf(stylist.id, now);
      if (blocksRetirement(work)) {
        throw new BusinessRuleViolationError(
          'STYLIST_HAS_PENDING_WORK',
          `${stylist.displayName} tiene ${describePending(work)}: resuélvelo antes de darla de baja`,
          {
            stylistId: stylist.id,
            appointments: work.appointments.total,
            pendingTickets: work.pendingTickets.total,
            activeQueueTurns: work.activeQueueTurns.length,
          },
        );
      }

      const releasedQueuePreferences = await this.offboarding.releaseQueuePreferences(stylist.id);

      const account = await accountOf(this.users, stylist);
      if (account.user && account.willBeDeactivated) {
        account.user.deactivate(now, input.actorId);
        await this.users.update(account.user);
        await this.audit.record({
          action: 'UPDATE',
          entityType: 'User',
          entityId: account.user.id,
          after: { status: 'INACTIVE' },
          metadata: { reason: 'STYLIST_RETIRED', stylistId: stylist.id },
        });
      }

      await this.stylists.softDelete(stylist.id, input.actorId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'Stylist',
        entityId: stylist.id,
        before: { name: stylist.name.full },
        metadata: {
          releasedQueuePreferences,
          accountDeactivated: account.willBeDeactivated,
        },
      });
    });
  }
}

/**
 * Reactiva a una profesional dada de baja: vuelve a la agenda y a la caja, y si su acceso
 * estaba desactivado, se vuelve a encender.
 */
@Injectable()
export class RestoreStylistUseCase implements UseCase<StylistIdInput, Stylist> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: StylistIdInput): Promise<Stylist> {
    return this.uow.execute(async () => {
      const restored = await this.stylists.restore(input.id, input.actorId);

      let accountReactivated = false;
      if (restored.userId) {
        const user = await this.users.findById(restored.userId);
        if (user && user.status === 'INACTIVE') {
          user.activate(this.clock.now(), input.actorId);
          await this.users.update(user);
          accountReactivated = true;
          await this.audit.record({
            action: 'UPDATE',
            entityType: 'User',
            entityId: user.id,
            after: { status: 'ACTIVE' },
            metadata: { reason: 'STYLIST_RESTORED', stylistId: restored.id },
          });
        }
      }

      await this.audit.record({
        action: 'RESTORE',
        entityType: 'Stylist',
        entityId: input.id,
        metadata: { accountReactivated },
      });
      return restored;
    });
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
