import {
  BusinessRuleViolationError,
  DomainValidationError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from '@shared/domain/errors';
import { Money } from '@shared/domain/value-objects/money.vo';
import { TimeRange } from '@shared/domain/value-objects/time-range.vo';

import { Appointment, type AppointmentLine } from './appointment.entity';
import { AvailabilityService } from './availability.service';

const NOW = new Date('2026-09-10T08:00:00.000Z');
const TENANT = '11111111-1111-7111-8111-111111111111';

const line = (minutes: number, price: string, id = `l-${minutes}`): AppointmentLine => ({
  id,
  serviceId: `svc-${minutes}`,
  durationMinutes: minutes,
  price: Money.fromDecimal(price, 'EUR'),
  sortOrder: 0,
});

describe('Appointment', () => {
  const schedule = (overrides: Partial<Parameters<typeof Appointment.schedule>[0]> = {}) =>
    Appointment.schedule({
      id: 'apt-1',
      tenantId: TENANT,
      clientId: 'client-1',
      stylistId: 'stylist-1',
      startsAt: new Date('2026-09-10T09:00:00.000Z'),
      lines: [line(45, '25.00')],
      currency: 'EUR',
      now: NOW,
      actorId: 'recepcion',
      ...overrides,
    });

  describe('reserva', () => {
    it('calcula el intervalo a partir de la suma de servicios', () => {
      const appointment = schedule({ lines: [line(45, '25.00'), line(30, '15.00', 'l-2')] });

      expect(appointment.durationMinutes).toBe(75);
      expect(appointment.period.endsAt.toISOString()).toBe('2026-09-10T10:15:00.000Z');
    });

    it('suma el importe previsto sin error de coma flotante', () => {
      const appointment = schedule({
        lines: [line(45, '25.10'), line(30, '15.20', 'l-2'), line(15, '9.70', 'l-3')],
      });

      expect(appointment.estimatedTotal.toDecimalString()).toBe('50.00');
    });

    it('nace pendiente y ocupando sillón', () => {
      const appointment = schedule();

      expect(appointment.status).toBe('SCHEDULED');
      expect(appointment.isBlocking).toBe(true);
      expect(appointment.isFinished).toBe(false);
    });

    it('exige al menos un servicio', () => {
      expect(() => schedule({ lines: [] })).toThrow(DomainValidationError);
    });

    it('rechaza agendar en el pasado', () => {
      // Casi siempre es un error de tecleo en la fecha.
      expect(() => schedule({ startsAt: new Date('2026-09-09T09:00:00.000Z') })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('tolera unos minutos de margen hacia atrás', () => {
      // La recepcionista que registra una visita que acaba de empezar no debería pelearse
      // con el reloj.
      expect(() => schedule({ startsAt: new Date(NOW.getTime() - 3 * 60_000) })).not.toThrow();
    });
  });

  describe('máquina de estados', () => {
    it('recorre el ciclo completo', () => {
      const appointment = schedule();

      appointment.confirm(NOW, 'recepcion');
      expect(appointment.status).toBe('CONFIRMED');
      expect(appointment.confirmedAt).toEqual(NOW);

      appointment.start(NOW, 'estilista');
      expect(appointment.status).toBe('IN_PROGRESS');

      appointment.complete(NOW, 'estilista');
      expect(appointment.status).toBe('COMPLETED');
      expect(appointment.isFinished).toBe(true);
      expect(appointment.isBlocking).toBe(false);
    });

    it('permite empezar sin confirmar', () => {
      // La clienta que aparece sin haber confirmado es lo más normal del mundo.
      const appointment = schedule();
      expect(() => appointment.start(NOW, 'estilista')).not.toThrow();
    });

    it('al completar sin inicio marcado asume la hora prevista', () => {
      // En un salón con trabajo nadie pulsa «empezar». Negarse a cerrar la cita por eso
      // solo conseguiría que la recepción dejase de usar el sistema.
      const appointment = schedule();
      appointment.start(NOW, 'estilista');
      appointment.complete(NOW, 'estilista');
      expect(appointment.startedAt).toEqual(NOW);
    });

    it('una cita completada no se puede cancelar', () => {
      const appointment = schedule();
      appointment.start(NOW, 'x');
      appointment.complete(NOW, 'x');

      expect(() => appointment.cancel('me arrepentí', NOW, 'x')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('una cita cancelada no se puede reabrir', () => {
      const appointment = schedule();
      appointment.cancel('imprevisto', NOW, 'recepcion');

      // Si la clienta vuelve a llamar se reserva una nueva. Reabrir la vieja borraría del
      // histórico que hubo una cancelación.
      expect(() => appointment.confirm(NOW, 'x')).toThrow(InvalidStateTransitionError);
      expect(() => appointment.start(NOW, 'x')).toThrow(InvalidStateTransitionError);
    });

    it('una cita en curso puede cancelarse pero no marcarse como no presentada', () => {
      const appointment = schedule();
      appointment.start(NOW, 'x');

      // Evidentemente se presentó.
      expect(() => appointment.markNoShow(NOW, 'x')).toThrow(InvalidStateTransitionError);
      expect(() => appointment.cancel('se marchó', NOW, 'x')).not.toThrow();
    });

    it('la cancelación guarda motivo y autor', () => {
      const appointment = schedule();
      appointment.cancel('  La clienta está enferma  ', NOW, 'recepcion');

      expect(appointment.cancellationReason).toBe('La clienta está enferma');
      expect(appointment.cancelledBy).toBe('recepcion');
      expect(appointment.cancelledAt).toEqual(NOW);
      expect(appointment.isBlocking).toBe(false);
    });

    it('un motivo vacío se guarda como ausente', () => {
      const appointment = schedule();
      appointment.cancel('   ', NOW, 'recepcion');
      expect(appointment.cancellationReason).toBeNull();
    });

    it('no se puede marcar no presentada antes de la hora', () => {
      const appointment = schedule({ startsAt: new Date('2026-09-10T15:00:00.000Z') });

      // Hacerlo antes es prejuzgar, y en la práctica siempre es un error de manejo.
      expect(() => appointment.markNoShow(NOW, 'recepcion')).toThrow(BusinessRuleViolationError);
    });

    it('se marca no presentada una vez pasada la hora', () => {
      const appointment = schedule();
      const later = new Date('2026-09-10T09:30:00.000Z');

      appointment.markNoShow(later, 'recepcion');

      expect(appointment.status).toBe('NO_SHOW');
      expect(appointment.noShowAt).toEqual(later);
      expect(appointment.isBlocking).toBe(false);
    });
  });

  describe('cambios de agenda', () => {
    it('mover la cita conserva la duración', () => {
      const appointment = schedule({ lines: [line(45, '25.00'), line(30, '15.00', 'l-2')] });

      appointment.rescheduleTo(new Date('2026-09-10T14:00:00.000Z'), NOW, 'recepcion');

      expect(appointment.period.startsAt.toISOString()).toBe('2026-09-10T14:00:00.000Z');
      expect(appointment.durationMinutes).toBe(75);
    });

    it('mover una cita confirmada la devuelve a pendiente', () => {
      const appointment = schedule();
      appointment.confirm(NOW, 'recepcion');

      appointment.rescheduleTo(new Date('2026-09-10T14:00:00.000Z'), NOW, 'recepcion');

      // La clienta confirmó *aquella* hora, no ésta. Hay que volver a pedírsela.
      expect(appointment.status).toBe('SCHEDULED');
      expect(appointment.confirmedAt).toBeNull();
    });

    it('mover la cita descarta el recordatorio enviado', () => {
      const appointment = schedule();
      appointment.markReminderSent(NOW);

      appointment.rescheduleTo(new Date('2026-09-10T14:00:00.000Z'), NOW, 'recepcion');

      expect(appointment.reminderSentAt).toBeNull();
    });

    it('no se puede mover una cita en curso ni una terminada', () => {
      const inProgress = schedule();
      inProgress.start(NOW, 'x');
      expect(() => inProgress.rescheduleTo(new Date('2026-09-10T14:00:00.000Z'), NOW, 'x')).toThrow(
        /ya ha empezado/,
      );

      const cancelled = schedule();
      cancelled.cancel('motivo', NOW, 'x');
      expect(() => cancelled.rescheduleTo(new Date('2026-09-10T14:00:00.000Z'), NOW, 'x')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('no se puede mover al pasado', () => {
      const appointment = schedule();
      expect(() =>
        appointment.rescheduleTo(new Date('2026-09-09T09:00:00.000Z'), NOW, 'x'),
      ).toThrow(BusinessRuleViolationError);
    });

    it('reasignar cambia de profesional sin mover la hora', () => {
      const appointment = schedule();
      const start = appointment.period.startsAt;

      appointment.reassignTo('stylist-2', NOW, 'recepcion');

      expect(appointment.stylistId).toBe('stylist-2');
      expect(appointment.period.startsAt).toEqual(start);
    });

    it('cambiar los servicios alarga la cita conservando el inicio', () => {
      const appointment = schedule();

      appointment.replaceLines([line(45, '25.00'), line(90, '55.00', 'l-2')], NOW, 'recepcion');

      // Quien añade un tratamiento espera terminar más tarde, no empezar antes.
      expect(appointment.period.startsAt.toISOString()).toBe('2026-09-10T09:00:00.000Z');
      expect(appointment.durationMinutes).toBe(135);
      expect(appointment.estimatedTotal.toDecimalString()).toBe('80.00');
    });

    it('no se puede dejar la cita sin servicios', () => {
      expect(() => schedule().replaceLines([], NOW, 'x')).toThrow(DomainValidationError);
    });

    it('las notas se pueden editar incluso en una cita terminada', () => {
      const appointment = schedule();
      appointment.start(NOW, 'x');
      appointment.complete(NOW, 'x');

      // Es donde se apunta la fórmula de color que se usó, y eso se recuerda después.
      appointment.updateNotes({ internalNotes: 'Fórmula 6.0 + 20 vol' }, NOW, 'estilista');

      expect(appointment.internalNotes).toBe('Fórmula 6.0 + 20 vol');
    });
  });

  describe('ámbito propio', () => {
    it('acepta al profesional dueño de la cita', () => {
      expect(() => schedule().assertOwnedBy('stylist-1')).not.toThrow();
    });

    it('rechaza a otro profesional sin revelar de quién es', () => {
      const error = (() => {
        try {
          schedule().assertOwnedBy('stylist-9');
          return null;
        } catch (caught) {
          return caught as Error;
        }
      })();

      expect(error).toBeInstanceOf(ForbiddenActionError);
      // Decir de quién es sería información sobre la agenda de una compañera.
      expect(error!.message).not.toContain('stylist-1');
    });
  });
});

describe('AvailabilityService', () => {
  const at = (hour: number, minute = 0): Date =>
    new Date(Date.UTC(2026, 8, 10, hour, minute, 0, 0));
  const range = (fromHour: number, toHour: number, fromMin = 0, toMin = 0): TimeRange =>
    TimeRange.create(at(fromHour, fromMin), at(toHour, toMin));

  describe('merge', () => {
    it('funde intervalos solapados', () => {
      const merged = AvailabilityService.merge([range(9, 11), range(10, 12)]);

      expect(merged).toHaveLength(1);
      expect(merged[0].endsAt).toEqual(at(12));
    });

    it('funde intervalos que solo se tocan', () => {
      // Dos citas consecutivas dejan un único bloque ocupado. Sin fundirlas, el recorte
      // produciría intervalos libres de duración cero.
      expect(AvailabilityService.merge([range(9, 10), range(10, 11)])).toHaveLength(1);
    });

    it('conserva intervalos separados', () => {
      expect(AvailabilityService.merge([range(9, 10), range(12, 13)])).toHaveLength(2);
    });

    it('ordena aunque lleguen desordenados', () => {
      const merged = AvailabilityService.merge([range(15, 16), range(9, 10)]);
      expect(merged[0].startsAt).toEqual(at(9));
    });

    it('una lista vacía produce una lista vacía', () => {
      expect(AvailabilityService.merge([])).toEqual([]);
    });
  });

  describe('subtract', () => {
    it('parte un tramo libre en dos', () => {
      const free = AvailabilityService.subtract([range(9, 20)], [range(12, 14)]);

      expect(free).toHaveLength(2);
      expect(free[0].endsAt).toEqual(at(12));
      expect(free[1].startsAt).toEqual(at(14));
    });

    it('elimina un tramo cubierto por completo', () => {
      expect(AvailabilityService.subtract([range(10, 11)], [range(9, 20)])).toEqual([]);
    });

    it('recorta por el principio y por el final', () => {
      expect(AvailabilityService.subtract([range(9, 20)], [range(8, 10)])[0].startsAt).toEqual(
        at(10),
      );
      expect(AvailabilityService.subtract([range(9, 20)], [range(19, 21)])[0].endsAt).toEqual(
        at(19),
      );
    });

    it('no toca lo que no se solapa', () => {
      expect(AvailabilityService.subtract([range(9, 12)], [range(15, 16)])).toHaveLength(1);
    });
  });

  describe('findSlots', () => {
    it('ofrece inicios cada cuarto de hora', () => {
      const slots = AvailabilityService.findSlots([range(9, 10)], [], {
        durationMinutes: 30,
        granularityMinutes: 15,
      });

      // 9:00, 9:15 y 9:30. A las 9:45 ya no cabría media hora.
      expect(slots).toHaveLength(3);
      expect(slots.map((slot) => slot.startsAt.getUTCMinutes())).toEqual([0, 15, 30]);
    });

    it('no ofrece huecos donde el servicio no cabe', () => {
      expect(AvailabilityService.findSlots([range(9, 10)], [], { durationMinutes: 90 })).toEqual(
        [],
      );
    });

    it('descuenta las citas existentes', () => {
      const slots = AvailabilityService.findSlots([range(9, 13)], [range(10, 11)], {
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      // Libre 9-10 y 11-13: caben las 9:00, 11:00 y 12:00.
      expect(slots.map((slot) => slot.startsAt.getUTCHours())).toEqual([9, 11, 12]);
    });

    it('alinea los huecos a la rejilla horaria del salón', () => {
      // La cita anterior acaba a las 10:07. Ofrecer «10:07» sería inservible para quien
      // atiende el teléfono.
      const slots = AvailabilityService.findSlots(
        [range(9, 13)],
        [TimeRange.create(at(9), at(10, 7))],
        { durationMinutes: 30, granularityMinutes: 15 },
      );

      expect(slots[0].startsAt).toEqual(at(10, 15));
    });

    it('respeta la antelación mínima', () => {
      const slots = AvailabilityService.findSlots([range(9, 13)], [], {
        durationMinutes: 30,
        granularityMinutes: 30,
        notBefore: at(9, 10),
        minimumNoticeMinutes: 60,
      });

      // 9:10 + 60 minutos de antelación = 10:10, alineado a la rejilla → 10:30.
      expect(slots[0].startsAt).toEqual(at(10, 30));
    });

    it('no ofrece huecos en el pasado', () => {
      const slots = AvailabilityService.findSlots([range(9, 13)], [], {
        durationMinutes: 60,
        granularityMinutes: 60,
        notBefore: at(11),
      });

      expect(slots.every((slot) => slot.startsAt.getTime() >= at(11).getTime())).toBe(true);
    });

    it('recorre varios tramos de una jornada partida', () => {
      const slots = AvailabilityService.findSlots([range(9, 11), range(16, 18)], [], {
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(slots.map((slot) => slot.startsAt.getUTCHours())).toEqual([9, 10, 16, 17]);
    });

    it('rechaza parámetros imposibles', () => {
      expect(() =>
        AvailabilityService.findSlots([range(9, 13)], [], { durationMinutes: 0 }),
      ).toThrow(DomainValidationError);
      expect(() =>
        AvailabilityService.findSlots([range(9, 13)], [], {
          durationMinutes: 30,
          granularityMinutes: 0,
        }),
      ).toThrow(DomainValidationError);
    });
  });

  describe('fitsIn', () => {
    it('acepta un hueco libre', () => {
      expect(AvailabilityService.fitsIn(range(10, 11), [range(9, 20)], [])).toBe(true);
    });

    it('rechaza si choca con una cita', () => {
      expect(AvailabilityService.fitsIn(range(10, 11), [range(9, 20)], [range(10, 12)])).toBe(
        false,
      );
    });

    it('rechaza si se sale del horario', () => {
      expect(AvailabilityService.fitsIn(range(19, 21), [range(9, 20)], [])).toBe(false);
    });
  });

  describe('métricas', () => {
    it('cuenta los minutos libres', () => {
      expect(AvailabilityService.freeMinutes([range(9, 20)], [range(12, 14)])).toBe(9 * 60);
    });

    it('calcula la ocupación en porcentaje', () => {
      // 2 horas ocupadas de 10 disponibles.
      expect(AvailabilityService.occupancyRate([range(9, 19)], [range(12, 14)])).toBe(20);
    });

    it('un día sin horario no está ocupado al 0%: no aplica', () => {
      // Devolver 0 evita la división por cero que reventaría el panel de un salón cerrado.
      expect(AvailabilityService.occupancyRate([], [])).toBe(0);
    });

    it('la ocupación completa es el 100%', () => {
      expect(AvailabilityService.occupancyRate([range(9, 13)], [range(9, 13)])).toBe(100);
    });
  });
});
