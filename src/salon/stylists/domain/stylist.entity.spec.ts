import { BusinessRuleViolationError, DomainValidationError } from '@shared/domain/errors';
import { PersonName } from '@shared/domain/value-objects/contact.vo';
import { Percentage, TimeRange } from '@shared/domain/value-objects/time-range.vo';

import { Stylist, type WorkingBlock } from './stylist.entity';

/**
 * El profesional es el agregado que decide cuándo se puede reservar. Casi todos estos
 * tests son, en el fondo, tests de la agenda: comprueban que el horario recurrente, las
 * ausencias y las habilidades se combinan en el orden correcto.
 */
describe('Stylist', () => {
  const MADRID = 'Europe/Madrid';
  const NOW = new Date('2026-09-02T10:00:00.000Z');
  const TENANT = '11111111-1111-7111-8111-111111111111';

  // 10 de septiembre de 2026 es jueves (día 4).
  const THURSDAY = { year: 2026, month: 9, day: 10 };

  const create = (): Stylist =>
    Stylist.create({
      id: 'stylist-1',
      tenantId: TENANT,
      name: PersonName.create('Sara', 'Molina'),
      commissionRate: Percentage.create(15),
      now: NOW,
      actorId: 'admin',
    });

  const block = (
    dayOfWeek: number,
    from: number,
    to: number,
    id = `b-${dayOfWeek}-${from}`,
  ): WorkingBlock => ({
    id,
    dayOfWeek,
    startMinutes: from * 60,
    endMinutes: to * 60,
  });

  describe('alta', () => {
    it('crea un profesional activo y reservable', () => {
      const stylist = create();

      expect(stylist.status).toBe('ACTIVE');
      expect(stylist.isBookable()).toBe(true);
      expect(stylist.schedule).toEqual([]);
      expect(stylist.commissionRate.value).toBe(15);
    });

    it('usa el nombre de pila como nombre visible si no se indica otro', () => {
      expect(create().displayName).toBe('Sara');
    });

    it('valida el color del calendario', () => {
      expect(() =>
        Stylist.create({
          id: 's',
          tenantId: TENANT,
          name: PersonName.create('Sara', 'Molina'),
          color: 'morado',
          now: NOW,
          actorId: null,
        }),
      ).toThrow(DomainValidationError);
    });
  });

  describe('horario semanal', () => {
    it('acepta varios tramos en un mismo día', () => {
      const stylist = create();

      // Jornada partida: es lo normal en un salón.
      stylist.replaceSchedule([block(4, 9, 14), block(4, 16, 20)], NOW, 'admin');

      expect(stylist.schedule).toHaveLength(2);
      expect(stylist.weeklyMinutes).toBe(9 * 60);
    });

    it('rechaza tramos solapados del mismo día', () => {
      const stylist = create();

      // Dos bloques superpuestos harían que el mismo hueco se ofreciera dos veces.
      expect(() =>
        stylist.replaceSchedule([block(4, 9, 14), block(4, 13, 20)], NOW, 'admin'),
      ).toThrow(BusinessRuleViolationError);
    });

    it('permite el mismo horario en días distintos', () => {
      const stylist = create();
      expect(() =>
        stylist.replaceSchedule([block(1, 9, 20), block(2, 9, 20)], NOW, 'admin'),
      ).not.toThrow();
    });

    it('rechaza tramos mal formados', () => {
      const stylist = create();

      expect(() => stylist.replaceSchedule([block(7, 9, 20)], NOW, 'admin')).toThrow(
        DomainValidationError,
      );
      expect(() => stylist.replaceSchedule([block(4, 20, 9)], NOW, 'admin')).toThrow(
        DomainValidationError,
      );
      expect(() => stylist.replaceSchedule([block(4, 9, 9)], NOW, 'admin')).toThrow(
        DomainValidationError,
      );
    });

    it('reemplaza el horario por completo, no acumula', () => {
      const stylist = create();

      stylist.replaceSchedule([block(1, 9, 20)], NOW, 'admin');
      stylist.replaceSchedule([block(2, 10, 18)], NOW, 'admin');

      expect(stylist.schedule).toHaveLength(1);
      expect(stylist.schedule[0].dayOfWeek).toBe(2);
    });
  });

  describe('disponibilidad', () => {
    it('convierte el horario local en instantes absolutos', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 14)], NOW, 'admin');

      const [interval] = stylist.workingIntervalsOn(THURSDAY, MADRID);

      // 10 de septiembre es horario de verano en Madrid: 09:00 local = 07:00 UTC.
      expect(interval.startsAt.toISOString()).toBe('2026-09-10T07:00:00.000Z');
      expect(interval.endsAt.toISOString()).toBe('2026-09-10T12:00:00.000Z');
    });

    it('el mismo horario da instantes distintos en invierno', () => {
      const stylist = create();
      // 15 de enero de 2026 es jueves.
      stylist.replaceSchedule([block(4, 9, 14)], NOW, 'admin');

      const [interval] = stylist.workingIntervalsOn({ year: 2026, month: 1, day: 15 }, MADRID);

      expect(interval.startsAt.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    });

    it('devuelve vacío en un día sin horario', () => {
      const stylist = create();
      stylist.replaceSchedule([block(1, 9, 20)], NOW, 'admin'); // solo lunes

      expect(stylist.workingIntervalsOn(THURSDAY, MADRID)).toEqual([]);
    });

    it('un profesional inactivo no tiene disponibilidad', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.changeStatus('INACTIVE', NOW, 'admin');

      expect(stylist.workingIntervalsOn(THURSDAY, MADRID)).toEqual([]);
      expect(stylist.isBookable()).toBe(false);
    });

    it('devuelve los tramos ordenados', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 16, 20), block(4, 9, 14)], NOW, 'admin');

      const intervals = stylist.workingIntervalsOn(THURSDAY, MADRID);

      expect(intervals).toHaveLength(2);
      expect(intervals[0].startsAt.getTime()).toBeLessThan(intervals[1].startsAt.getTime());
    });

    it('admite un tramo que termina a medianoche', () => {
      const stylist = create();
      stylist.replaceSchedule(
        [{ id: 'b', dayOfWeek: 4, startMinutes: 20 * 60, endMinutes: 1440 }],
        NOW,
        'admin',
      );

      const [interval] = stylist.workingIntervalsOn(THURSDAY, MADRID);

      // Medianoche pertenece ya al día siguiente: convertirla con la fecha original
      // produciría un intervalo invertido.
      expect(interval.endsAt.toISOString()).toBe('2026-09-10T22:00:00.000Z');
    });
  });

  describe('ausencias', () => {
    const morningOff = (): TimeRange =>
      TimeRange.create(
        new Date('2026-09-10T10:00:00.000Z'), // 12:00 local
        new Date('2026-09-10T12:00:00.000Z'), // 14:00 local
      );

    it('parte un tramo de trabajo en dos', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff({ id: 'off-1', range: morningOff(), reason: 'Formación' }, NOW, 'admin');

      const intervals = stylist.workingIntervalsOn(THURSDAY, MADRID);

      // Una formación de 12 a 14 en una jornada de 9 a 20 deja libres 9-12 y 14-20. No
      // basta con descartar el tramo: hay que recortarlo.
      expect(intervals).toHaveLength(2);
      expect(intervals[0].endsAt.toISOString()).toBe('2026-09-10T10:00:00.000Z');
      expect(intervals[1].startsAt.toISOString()).toBe('2026-09-10T12:00:00.000Z');
    });

    it('elimina por completo un tramo cubierto entero', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff(
        {
          id: 'off-1',
          range: TimeRange.create(
            new Date('2026-09-10T00:00:00.000Z'),
            new Date('2026-09-11T00:00:00.000Z'),
          ),
          reason: 'Vacaciones',
        },
        NOW,
        'admin',
      );

      expect(stylist.workingIntervalsOn(THURSDAY, MADRID)).toEqual([]);
    });

    it('recorta solo el principio cuando la ausencia empieza antes', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff(
        {
          id: 'off-1',
          range: TimeRange.create(
            new Date('2026-09-10T05:00:00.000Z'),
            new Date('2026-09-10T09:00:00.000Z'), // hasta las 11 local
          ),
          reason: null,
        },
        NOW,
        'admin',
      );

      const intervals = stylist.workingIntervalsOn(THURSDAY, MADRID);

      expect(intervals).toHaveLength(1);
      expect(intervals[0].startsAt.toISOString()).toBe('2026-09-10T09:00:00.000Z');
    });

    it('acumula varias ausencias en el mismo día', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff({ id: 'off-1', range: morningOff(), reason: null }, NOW, 'admin');
      stylist.addTimeOff(
        {
          id: 'off-2',
          range: TimeRange.create(
            new Date('2026-09-10T14:00:00.000Z'),
            new Date('2026-09-10T15:00:00.000Z'),
          ),
          reason: null,
        },
        NOW,
        'admin',
      );

      expect(stylist.workingIntervalsOn(THURSDAY, MADRID)).toHaveLength(3);
    });

    it('rechaza ausencias solapadas', () => {
      const stylist = create();
      stylist.addTimeOff({ id: 'off-1', range: morningOff(), reason: null }, NOW, 'admin');

      expect(() =>
        stylist.addTimeOff(
          {
            id: 'off-2',
            range: TimeRange.create(
              new Date('2026-09-10T11:00:00.000Z'),
              new Date('2026-09-10T13:00:00.000Z'),
            ),
            reason: null,
          },
          NOW,
          'admin',
        ),
      ).toThrow(BusinessRuleViolationError);
    });

    it('elimina una ausencia y devuelve el tiempo trabajable', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff({ id: 'off-1', range: morningOff(), reason: null }, NOW, 'admin');

      stylist.removeTimeOff('off-1', NOW, 'admin');

      expect(stylist.workingIntervalsOn(THURSDAY, MADRID)).toHaveLength(1);
    });

    it('falla al eliminar una ausencia inexistente', () => {
      expect(() => create().removeTimeOff('no-existe', NOW, 'admin')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('isOnLeaveDuring detecta el solapamiento', () => {
      const stylist = create();
      stylist.addTimeOff({ id: 'off-1', range: morningOff(), reason: null }, NOW, 'admin');

      expect(stylist.isOnLeaveDuring(morningOff())).toBe(true);
      expect(
        stylist.isOnLeaveDuring(
          TimeRange.create(
            new Date('2026-09-10T15:00:00.000Z'),
            new Date('2026-09-10T16:00:00.000Z'),
          ),
        ),
      ).toBe(false);
    });
  });

  describe('isWithinWorkingHours', () => {
    it('acepta una cita dentro de la jornada', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');

      const appointment = TimeRange.create(
        new Date('2026-09-10T09:00:00.000Z'), // 11:00 local
        new Date('2026-09-10T10:00:00.000Z'),
      );

      expect(stylist.isWithinWorkingHours(appointment, MADRID)).toBe(true);
    });

    it('rechaza una cita que se sale del horario', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 14)], NOW, 'admin');

      const appointment = TimeRange.create(
        new Date('2026-09-10T11:30:00.000Z'), // 13:30-14:30 local, se pasa del cierre
        new Date('2026-09-10T12:30:00.000Z'),
      );

      expect(stylist.isWithinWorkingHours(appointment, MADRID)).toBe(false);
    });

    it('rechaza una cita que cae en una ausencia', () => {
      const stylist = create();
      stylist.replaceSchedule([block(4, 9, 20)], NOW, 'admin');
      stylist.addTimeOff(
        {
          id: 'off-1',
          range: TimeRange.create(
            new Date('2026-09-10T10:00:00.000Z'),
            new Date('2026-09-10T12:00:00.000Z'),
          ),
          reason: null,
        },
        NOW,
        'admin',
      );

      const appointment = TimeRange.create(
        new Date('2026-09-10T10:30:00.000Z'),
        new Date('2026-09-10T11:00:00.000Z'),
      );

      expect(stylist.isWithinWorkingHours(appointment, MADRID)).toBe(false);
    });

    it('una cita a caballo de dos tramos no cabe en ninguno', () => {
      const stylist = create();
      // Jornada partida: 9-14 y 16-20.
      stylist.replaceSchedule([block(4, 9, 14), block(4, 16, 20)], NOW, 'admin');

      const overLunch = TimeRange.create(
        new Date('2026-09-10T11:30:00.000Z'), // 13:30
        new Date('2026-09-10T14:30:00.000Z'), // 16:30
      );

      expect(stylist.isWithinWorkingHours(overLunch, MADRID)).toBe(false);
    });
  });

  describe('habilidades', () => {
    it('sin habilidades declaradas puede hacer cualquier servicio', () => {
      // Es lo que espera un salón pequeño recién dado de alta: exigir la matriz completa
      // de servicio×profesional antes de la primera cita sería un estorbo.
      expect(create().canPerform('cualquiera')).toBe(true);
    });

    it('con habilidades declaradas solo hace las suyas', () => {
      const stylist = create();
      stylist.replaceSkills(
        [{ serviceId: 'svc-corte', durationMinutes: null, commissionRate: null }],
        NOW,
        'admin',
      );

      expect(stylist.canPerform('svc-corte')).toBe(true);
      expect(stylist.canPerform('svc-color')).toBe(false);
    });

    it('la duración personalizada tiene prioridad sobre la del catálogo', () => {
      const stylist = create();
      stylist.replaceSkills(
        [{ serviceId: 'svc-corte', durationMinutes: 30, commissionRate: null }],
        NOW,
        'admin',
      );

      // Una estilista veterana que tarda 30 en lo que el catálogo reserva 45 libera un
      // hueco vendible cada vez.
      expect(stylist.durationFor('svc-corte', 45)).toBe(30);
      expect(stylist.durationFor('svc-color', 90)).toBe(90);
    });

    it('la comisión sigue el orden habilidad → servicio → profesional', () => {
      const stylist = create(); // comisión general del 15%
      stylist.replaceSkills(
        [
          { serviceId: 'svc-mechas', durationMinutes: null, commissionRate: Percentage.create(25) },
          { serviceId: 'svc-corte', durationMinutes: null, commissionRate: null },
        ],
        NOW,
        'admin',
      );

      expect(stylist.commissionFor('svc-mechas', Percentage.create(10)).value).toBe(25);
      expect(stylist.commissionFor('svc-corte', Percentage.create(10)).value).toBe(10);
      expect(stylist.commissionFor('svc-corte', null).value).toBe(15);
    });

    it('rechaza un servicio repetido', () => {
      const stylist = create();

      expect(() =>
        stylist.replaceSkills(
          [
            { serviceId: 'svc-corte', durationMinutes: 30, commissionRate: null },
            { serviceId: 'svc-corte', durationMinutes: 45, commissionRate: null },
          ],
          NOW,
          'admin',
        ),
      ).toThrow(DomainValidationError);
    });

    it('rechaza una duración personalizada no positiva', () => {
      const stylist = create();

      expect(() =>
        stylist.replaceSkills(
          [{ serviceId: 'svc-corte', durationMinutes: 0, commissionRate: null }],
          NOW,
          'admin',
        ),
      ).toThrow(DomainValidationError);
    });
  });
});
