import { BusinessRuleViolationError, EntityNotFoundError } from '@shared/domain/errors';
import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import { aUser, OWNER_ROLE, STYLIST_ROLE } from '@test/builders/user.builder';
import { InMemoryAuditRecorder } from '@test/doubles/auth.doubles';
import { InMemoryUserRepository } from '@test/doubles/in-memory-user.repository';
import {
  FakeStylistOffboarding,
  InMemoryStylistRepository,
  passthroughUnitOfWork,
} from '@test/doubles/salon.doubles';

import {
  AddTimeOffUseCase,
  CheckStylistRetirementUseCase,
  CreateStylistUseCase,
  DeleteStylistUseCase,
  GetStylistUseCase,
  GetStylistWorkingHoursUseCase,
  RemoveTimeOffUseCase,
  RestoreStylistUseCase,
  SearchStylistsUseCase,
  SetStylistScheduleUseCase,
  SetStylistSkillsUseCase,
  UpdateStylistUseCase,
} from './stylist.use-cases';

describe('Casos de uso de profesionales', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const MADRID = 'Europe/Madrid';
  const NOW = new Date('2026-09-02T10:00:00.000Z');

  let stylists: InMemoryStylistRepository;
  let users: InMemoryUserRepository;
  let offboarding: FakeStylistOffboarding;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;

  let create: CreateStylistUseCase;
  let update: UpdateStylistUseCase;
  let getOne: GetStylistUseCase;
  let search: SearchStylistsUseCase;
  let remove: DeleteStylistUseCase;
  let restore: RestoreStylistUseCase;
  let checkRetirement: CheckStylistRetirementUseCase;
  let setSchedule: SetStylistScheduleUseCase;
  let addTimeOff: AddTimeOffUseCase;
  let removeTimeOff: RemoveTimeOffUseCase;
  let setSkills: SetStylistSkillsUseCase;
  let workingHours: GetStylistWorkingHoursUseCase;

  beforeEach(() => {
    stylists = new InMemoryStylistRepository();
    users = new InMemoryUserRepository();
    offboarding = new FakeStylistOffboarding();
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);
    ids = new SequentialIdGenerator();

    const salon = { timeZone: MADRID };

    create = new CreateStylistUseCase(stylists, ids, clock, audit);
    update = new UpdateStylistUseCase(stylists, clock, audit);
    getOne = new GetStylistUseCase(stylists);
    search = new SearchStylistsUseCase(stylists);
    remove = new DeleteStylistUseCase(
      stylists,
      offboarding,
      users,
      passthroughUnitOfWork,
      clock,
      audit,
    );
    restore = new RestoreStylistUseCase(stylists, users, passthroughUnitOfWork, clock, audit);
    checkRetirement = new CheckStylistRetirementUseCase(stylists, offboarding, users, clock);
    setSchedule = new SetStylistScheduleUseCase(stylists, ids, clock, audit);
    addTimeOff = new AddTimeOffUseCase(stylists, ids, clock, audit);
    removeTimeOff = new RemoveTimeOffUseCase(stylists, clock, audit);
    setSkills = new SetStylistSkillsUseCase(stylists, clock, audit);
    workingHours = new GetStylistWorkingHoursUseCase(stylists, salon);
  });

  const newStylist = (overrides: Record<string, unknown> = {}) =>
    create.execute({
      tenantId: TENANT,
      firstName: 'Sara',
      lastName: 'Molina',
      actorId: 'admin',
      ...overrides,
    });

  describe('alta y perfil', () => {
    it('crea un profesional activo', async () => {
      const stylist = await newStylist({ commissionRate: 15 });

      expect(stylist.isBookable()).toBe(true);
      expect(stylist.commissionRate.value).toBe(15);
      expect(audit.has('CREATE')).toBe(true);
    });

    it('admite contacto y cuenta de acceso opcionales', async () => {
      const stylist = await newStylist({
        email: 'sara@salon.es',
        phone: '+34600111222',
        userId: 'user-1',
        displayName: 'Sara M.',
      });

      expect(stylist.email?.value).toBe('sara@salon.es');
      expect(stylist.phone?.value).toBe('+34600111222');
      expect(stylist.displayName).toBe('Sara M.');
    });

    it('actualiza solo lo indicado', async () => {
      const stylist = await newStylist({ bio: 'Especialista en color' });

      const updated = await update.execute({
        id: stylist.id,
        commissionRate: 20,
        actorId: 'admin',
      });

      expect(updated.commissionRate.value).toBe(20);
      expect(updated.bio).toBe('Especialista en color');
    });

    it('cambia el estado y deja de admitir reservas', async () => {
      const stylist = await newStylist();

      const updated = await update.execute({
        id: stylist.id,
        status: 'ON_LEAVE',
        actorId: 'admin',
      });

      expect(updated.isBookable()).toBe(false);
      const entry = audit.entries.find((e) => e.action === 'UPDATE');
      expect(entry!.before).toMatchObject({ status: 'ACTIVE' });
    });

    it('permite vaciar el correo con null', async () => {
      const stylist = await newStylist({ email: 'sara@salon.es' });

      const updated = await update.execute({ id: stylist.id, email: null, actorId: 'admin' });

      expect(updated.email).toBeNull();
    });

    it('renombra combinando nombre y apellidos', async () => {
      const stylist = await newStylist();

      const updated = await update.execute({
        id: stylist.id,
        firstName: 'Sara María',
        actorId: 'x',
      });

      expect(updated.name.full).toBe('Sara María Molina');
    });

    it('falla al actualizar uno inexistente', async () => {
      await expect(update.execute({ id: 'no-existe', actorId: 'x' })).rejects.toThrow(
        EntityNotFoundError,
      );
    });
  });

  describe('baja y recuperación', () => {
    it('da de baja y deja de encontrarse', async () => {
      const stylist = await newStylist();

      await remove.execute({ id: stylist.id, actorId: 'admin' });

      await expect(getOne.execute(stylist.id)).rejects.toThrow(EntityNotFoundError);
      expect(audit.has('DELETE')).toBe(true);
    });

    it('recupera al profesional dado de baja', async () => {
      const stylist = await newStylist();
      await remove.execute({ id: stylist.id, actorId: 'admin' });

      const restored = await restore.execute({ id: stylist.id, actorId: 'admin' });

      expect(restored.id).toBe(stylist.id);
      expect(audit.has('RESTORE')).toBe(true);
    });

    it('no la da de baja con citas, comandas o turnos pendientes', async () => {
      const stylist = await newStylist();
      offboarding.withPendingWork(stylist.id, {
        appointments: {
          total: 2,
          items: [
            {
              id: 'cita-1',
              startsAt: new Date('2026-09-05T10:00:00.000Z'),
              endsAt: new Date('2026-09-05T11:00:00.000Z'),
              status: 'CONFIRMED',
              clientName: 'Rosa Iglesias',
              serviceNames: ['Corte'],
            },
          ],
        },
        pendingTickets: { total: 1, items: [] },
        activeQueueTurns: [{ id: 't-1', number: 4, clientName: 'Eva', status: 'IN_SERVICE' }],
      });

      const error = await remove
        .execute({ id: stylist.id, actorId: 'admin' })
        .then(() => new Error('se esperaba el rechazo'))
        .catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as BusinessRuleViolationError).code).toBe('STYLIST_HAS_PENDING_WORK');
      expect(error.message).toContain(
        '2 citas pendientes, 1 comanda sin cobrar y 1 turno en curso',
      );
      // Sigue en el equipo, y nada se tocó.
      await expect(getOne.execute(stylist.id)).resolves.toBeDefined();
      expect(offboarding.released).toEqual([]);
    });

    it('pasa a la fila general a las clientas en espera que la pidieron', async () => {
      const stylist = await newStylist();
      offboarding.withPendingWork(stylist.id, { waitingPreferences: 3 });

      const check = await checkRetirement.execute({ id: stylist.id });
      expect(check.blocked).toBe(false);
      expect(check.pendingWork.waitingPreferences).toBe(3);

      await remove.execute({ id: stylist.id, actorId: 'admin' });

      expect(offboarding.released).toEqual([stylist.id]);
    });

    it('apaga su acceso al sistema y cierra sus sesiones', async () => {
      const account = aUser().withRoles(STYLIST_ROLE).build();
      users.seed(account);
      const stylist = await newStylist({ userId: account.id });
      const tokenVersion = account.tokenVersion;

      const check = await checkRetirement.execute({ id: stylist.id });
      expect(check.account).toEqual({ linked: true, willBeDeactivated: true });

      await remove.execute({ id: stylist.id, actorId: 'admin' });

      const after = await users.findById(account.id);
      expect(after?.status).toBe('INACTIVE');
      expect(after?.tokenVersion).toBe(tokenVersion + 1);
    });

    it('no le quita el acceso a una dueña que también atiende', async () => {
      const owner = aUser().withRoles(OWNER_ROLE, STYLIST_ROLE).build();
      users.seed(owner);
      const stylist = await newStylist({ userId: owner.id });

      expect((await checkRetirement.execute({ id: stylist.id })).account.willBeDeactivated).toBe(
        false,
      );
      await remove.execute({ id: stylist.id, actorId: 'admin' });

      expect((await users.findById(owner.id))?.status).toBe('ACTIVE');
    });

    it('al reactivarla le devuelve el acceso', async () => {
      const account = aUser().withRoles(STYLIST_ROLE).build();
      users.seed(account);
      const stylist = await newStylist({ userId: account.id });
      await remove.execute({ id: stylist.id, actorId: 'admin' });

      await restore.execute({ id: stylist.id, actorId: 'admin' });

      expect((await users.findById(account.id))?.status).toBe('ACTIVE');
      await expect(getOne.execute(stylist.id)).resolves.toBeDefined();
    });

    it('una profesional sin cuenta se da de baja igual', async () => {
      const stylist = await newStylist();

      expect((await checkRetirement.execute({ id: stylist.id })).account).toEqual({
        linked: false,
        willBeDeactivated: false,
      });
      await remove.execute({ id: stylist.id, actorId: 'admin' });

      await expect(getOne.execute(stylist.id)).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe('horario', () => {
    it('genera un identificador por tramo', async () => {
      const stylist = await newStylist();

      const updated = await setSchedule.execute({
        stylistId: stylist.id,
        blocks: [
          { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 14 * 60 },
          { dayOfWeek: 1, startMinutes: 16 * 60, endMinutes: 20 * 60 },
        ],
        actorId: 'admin',
      });

      expect(updated.schedule).toHaveLength(2);
      expect(new Set(updated.schedule.map((b) => b.id)).size).toBe(2);
      expect(updated.weeklyMinutes).toBe(9 * 60);
    });

    it('rechaza tramos solapados', async () => {
      const stylist = await newStylist();

      await expect(
        setSchedule.execute({
          stylistId: stylist.id,
          blocks: [
            { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 14 * 60 },
            { dayOfWeek: 1, startMinutes: 13 * 60, endMinutes: 20 * 60 },
          ],
          actorId: 'admin',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('un horario vacío deja al profesional sin disponibilidad', async () => {
      const stylist = await newStylist();
      await setSchedule.execute({
        stylistId: stylist.id,
        blocks: [{ dayOfWeek: 4, startMinutes: 9 * 60, endMinutes: 20 * 60 }],
        actorId: 'admin',
      });

      const cleared = await setSchedule.execute({
        stylistId: stylist.id,
        blocks: [],
        actorId: 'admin',
      });

      expect(cleared.schedule).toEqual([]);
      expect(cleared.weeklyMinutes).toBe(0);
    });
  });

  describe('ausencias', () => {
    it('registra una ausencia y la audita', async () => {
      const stylist = await newStylist();

      const updated = await addTimeOff.execute({
        stylistId: stylist.id,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-15T00:00:00.000Z'),
        reason: 'Vacaciones',
        actorId: 'admin',
      });

      expect(updated.timeOff).toHaveLength(1);
      // Se audita porque puede dejar citas ya reservadas fuera del horario.
      expect(audit.entries.some((e) => e.entityType === 'StylistTimeOff')).toBe(true);
    });

    it('rechaza ausencias solapadas', async () => {
      const stylist = await newStylist();
      const base = {
        stylistId: stylist.id,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-15T00:00:00.000Z'),
        actorId: 'admin',
      };

      await addTimeOff.execute(base);

      await expect(
        addTimeOff.execute({ ...base, startsAt: new Date('2026-08-10T00:00:00.000Z') }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });

    it('elimina una ausencia', async () => {
      const stylist = await newStylist();
      const withTimeOff = await addTimeOff.execute({
        stylistId: stylist.id,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-15T00:00:00.000Z'),
        actorId: 'admin',
      });

      const cleared = await removeTimeOff.execute({
        stylistId: stylist.id,
        timeOffId: withTimeOff.timeOff[0].id,
        actorId: 'admin',
      });

      expect(cleared.timeOff).toEqual([]);
    });

    it('falla al eliminar una ausencia inexistente', async () => {
      const stylist = await newStylist();

      await expect(
        removeTimeOff.execute({ stylistId: stylist.id, timeOffId: 'no-existe', actorId: 'x' }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });
  });

  describe('habilidades', () => {
    it('guarda ajustes de duración y comisión', async () => {
      const stylist = await newStylist();

      const updated = await setSkills.execute({
        stylistId: stylist.id,
        skills: [
          { serviceId: 'svc-1', durationMinutes: 30, commissionRate: 25 },
          { serviceId: 'svc-2' },
        ],
        actorId: 'admin',
      });

      expect(updated.skills).toHaveLength(2);
      expect(updated.skills[0].commissionRate?.value).toBe(25);
      expect(updated.skills[1].durationMinutes).toBeNull();
      expect(updated.skills[1].commissionRate).toBeNull();
    });

    it('una lista vacía significa que puede hacerlo todo', async () => {
      const stylist = await newStylist();
      await setSkills.execute({
        stylistId: stylist.id,
        skills: [{ serviceId: 'svc-1' }],
        actorId: 'admin',
      });

      const cleared = await setSkills.execute({
        stylistId: stylist.id,
        skills: [],
        actorId: 'admin',
      });

      expect(cleared.canPerform('cualquiera')).toBe(true);
    });
  });

  describe('búsqueda', () => {
    it('filtra por estado y por texto', async () => {
      await newStylist({ firstName: 'Sara', lastName: 'Molina' });
      const marta = await newStylist({ firstName: 'Marta', lastName: 'Delgado' });
      await update.execute({ id: marta.id, status: 'INACTIVE', actorId: 'x' });

      const activos = await search.execute({
        filter: { status: 'ACTIVE' },
        page: { page: 1, limit: 20 },
      });
      const porNombre = await search.execute({
        filter: { search: 'delgado' },
        page: { page: 1, limit: 20 },
      });

      expect(activos.meta.total).toBe(1);
      expect(porNombre.meta.total).toBe(1);
    });

    it('filtra por quién puede hacer un servicio', async () => {
      const sara = await newStylist({ firstName: 'Sara', lastName: 'Molina' });
      await newStylist({ firstName: 'Marta', lastName: 'Delgado' });

      await setSkills.execute({
        stylistId: sara.id,
        skills: [{ serviceId: 'svc-1' }],
        actorId: 'x',
      });

      const page = await search.execute({
        filter: { canPerformServiceId: 'svc-2' },
        page: { page: 1, limit: 20 },
      });

      // Sara declaró habilidades y no incluye svc-2; Marta no declaró ninguna, así que se
      // asume que puede hacerlo todo.
      expect(page.meta.total).toBe(1);
      expect(page.data[0].name.firstName).toBe('Marta');
    });
  });

  describe('horario trabajable', () => {
    it('devuelve los tramos como instantes por día', async () => {
      const stylist = await newStylist();
      await setSchedule.execute({
        stylistId: stylist.id,
        blocks: [{ dayOfWeek: 4, startMinutes: 9 * 60, endMinutes: 14 * 60 }],
        actorId: 'admin',
      });

      const days = await workingHours.execute({
        stylistId: stylist.id,
        from: '2026-09-10',
        to: '2026-09-11',
      });

      expect(days).toHaveLength(2);
      // Jueves, en horario de verano: 09:00 local = 07:00 UTC.
      expect(days[0].intervals[0].startsAt).toBe('2026-09-10T07:00:00.000Z');
      expect(days[0].totalMinutes).toBe(300);
      // Viernes: sin horario.
      expect(days[1].intervals).toEqual([]);
      expect(days[1].totalMinutes).toBe(0);
    });

    it('descuenta las ausencias', async () => {
      const stylist = await newStylist();
      await setSchedule.execute({
        stylistId: stylist.id,
        blocks: [{ dayOfWeek: 4, startMinutes: 9 * 60, endMinutes: 20 * 60 }],
        actorId: 'admin',
      });
      await addTimeOff.execute({
        stylistId: stylist.id,
        startsAt: new Date('2026-09-10T10:00:00.000Z'),
        endsAt: new Date('2026-09-10T12:00:00.000Z'),
        actorId: 'admin',
      });

      const days = await workingHours.execute({
        stylistId: stylist.id,
        from: '2026-09-10',
        to: '2026-09-10',
      });

      expect(days[0].intervals).toHaveLength(2);
      expect(days[0].totalMinutes).toBe(9 * 60);
    });

    it('rechaza un rango desmesurado', async () => {
      const stylist = await newStylist();

      // Sin tope, una petición podría pedir un año entero por descuido.
      await expect(
        workingHours.execute({ stylistId: stylist.id, from: '2026-01-01', to: '2026-12-31' }),
      ).rejects.toThrow(/62 días/);
    });
  });
});
