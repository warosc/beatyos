import { DomainValidationError } from '@shared/domain/errors';
import { Money } from '@shared/domain/value-objects/money.vo';

import {
  resolveQueuePeriod,
  summarizeMinutes,
  summarizeQueue,
  waitMinutes,
  type QueueTurnFact,
} from './queue-stats';

describe('Indicadores de la fila', () => {
  const TZ = 'America/Guatemala';
  const TODAY = '2026-10-12'; // lunes
  const YESTERDAY = '2026-10-11'; // domingo

  /** Hora local de Guatemala (UTC−6) de un día dado. */
  const at = (date: string, time: string) => new Date(`${date}T${time}:00.000-06:00`);

  const fact = (overrides: Partial<QueueTurnFact>): QueueTurnFact => ({
    businessDate: YESTERDAY,
    status: 'WAITING',
    createdAt: at(YESTERDAY, '09:00'),
    firstCalledAt: null,
    startedAt: null,
    closedAt: null,
    stylistId: null,
    preferredStylistId: null,
    serviceIds: [],
    charged: null,
    ...overrides,
  });

  const options = (from = YESTERDAY, to = TODAY) => ({
    period: { from, to },
    today: TODAY,
    timeZone: TZ,
    currency: 'GTQ',
  });

  describe('periodo', () => {
    it('sin fechas, los últimos días hasta hoy incluido', () => {
      expect(resolveQueuePeriod({ today: TODAY, fallbackDays: 30 })).toEqual({
        from: '2026-09-13',
        to: TODAY,
      });
    });

    it('respeta las fechas pedidas', () => {
      expect(
        resolveQueuePeriod({
          from: '2026-10-01',
          to: '2026-10-05',
          today: TODAY,
          fallbackDays: 30,
        }),
      ).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    });

    it('rechaza un periodo al revés, de más de un año o con fechas mal escritas', () => {
      const resolve = (from: string, to: string) =>
        resolveQueuePeriod({ from, to, today: TODAY, fallbackDays: 30 });
      expect(() => resolve('2026-10-05', '2026-10-01')).toThrow(/anterior/);
      expect(() => resolve('2025-10-01', '2026-10-12')).toThrow(/máximo/);
      expect(() => resolve('12/10/2026', '2026-10-12')).toThrow(DomainValidationError);
    });
  });

  describe('resumen de minutos', () => {
    it('media, mediana, p90 y máximo, en minutos enteros', () => {
      expect(summarizeMinutes([40, 5, 20, 10])).toEqual({
        average: 19,
        median: 10,
        p90: 40,
        max: 40,
        samples: 4,
      });
    });

    it('sin muestras no inventa cifras', () => {
      expect(summarizeMinutes([])).toEqual({
        average: null,
        median: null,
        p90: null,
        max: null,
        samples: 0,
      });
    });

    it('la espera es hasta la primera llamada; sin llamada, no hay espera que contar', () => {
      expect(
        waitMinutes({ createdAt: at(TODAY, '09:00'), firstCalledAt: at(TODAY, '09:12') }),
      ).toBe(12);
      expect(waitMinutes({ createdAt: at(TODAY, '09:00'), firstCalledAt: null })).toBeNull();
    });
  });

  describe('un día con de todo', () => {
    const turns: QueueTurnFact[] = [
      // Atendida por Sara: esperó 10, sillón 40, cobrada.
      fact({
        status: 'DONE',
        firstCalledAt: at(YESTERDAY, '09:10'),
        startedAt: at(YESTERDAY, '09:12'),
        closedAt: at(YESTERDAY, '09:52'),
        stylistId: 'sara',
        serviceIds: ['cut'],
        charged: Money.fromDecimal('100.00', 'GTQ'),
      }),
      // Pidió a Valeria: esperó 30, sillón 30, aún sin cobrar.
      fact({
        status: 'DONE',
        createdAt: at(YESTERDAY, '09:30'),
        firstCalledAt: at(YESTERDAY, '10:00'),
        startedAt: at(YESTERDAY, '10:00'),
        closedAt: at(YESTERDAY, '10:30'),
        stylistId: 'valeria',
        preferredStylistId: 'valeria',
        serviceIds: ['cut', 'color'],
      }),
      // Se fue a los 25 minutos sin que la llamaran.
      fact({
        status: 'CANCELLED',
        createdAt: at(YESTERDAY, '09:40'),
        closedAt: at(YESTERDAY, '10:05'),
      }),
      // La llamaron a los 5 y no apareció.
      fact({
        status: 'NO_SHOW',
        createdAt: at(YESTERDAY, '11:00'),
        firstCalledAt: at(YESTERDAY, '11:05'),
        closedAt: at(YESTERDAY, '11:10'),
      }),
      // Se quedó en la fila al cerrar.
      fact({ createdAt: at(YESTERDAY, '12:00') }),
      // Hoy, todavía esperando.
      fact({ businessDate: TODAY, createdAt: at(TODAY, '09:20') }),
      // Fuera del periodo.
      fact({ businessDate: '2026-10-01', status: 'DONE' }),
    ];
    const stats = summarizeQueue(turns, options());

    it('cuenta llegadas, atendidas y cada forma de perderlas', () => {
      expect(stats).toMatchObject({
        period: { from: YESTERDAY, to: TODAY },
        arrivals: 6,
        attended: 2,
        left: 1,
        noShow: 1,
        unattended: 1,
        pending: 1,
        abandoned: 3,
        // 3 perdidas de 5 resueltas: la de hoy aún no cuenta.
        abandonmentRate: 60,
      });
    });

    it('mide la espera, cuánto aguantan las que se van y el tiempo de sillón', () => {
      expect(stats.wait).toEqual({ average: 15, median: 10, p90: 30, max: 30, samples: 3 });
      expect(stats.waitBeforeLeaving).toMatchObject({ average: 25, samples: 1 });
      expect(stats.service).toMatchObject({ average: 35, samples: 2 });
    });

    it('suma lo que ya se cobró', () => {
      expect(stats.revenue.toDecimalString()).toBe('100.00');
      expect(stats.chargedTurns).toBe(1);
    });

    it('agrupa por hora local de llegada, sin huecos entre la primera y la última', () => {
      expect(stats.byHour).toEqual([
        { hour: 9, arrivals: 4, abandoned: 1, averageWait: 20 },
        { hour: 10, arrivals: 0, abandoned: 0, averageWait: null },
        { hour: 11, arrivals: 1, abandoned: 1, averageWait: 5 },
        { hour: 12, arrivals: 1, abandoned: 1, averageWait: null },
      ]);
    });

    it('agrupa por día y por día de la semana', () => {
      expect(stats.byDay).toEqual([
        { date: YESTERDAY, arrivals: 5, attended: 2, abandoned: 3, averageWait: 15 },
        { date: TODAY, arrivals: 1, attended: 0, abandoned: 0, averageWait: null },
      ]);
      expect(stats.byWeekday[0]).toEqual({
        weekday: 0,
        arrivals: 5,
        arrivalsPerDay: 5,
        averageWait: 15,
      });
      expect(stats.byWeekday[1]).toMatchObject({ weekday: 1, arrivals: 1, arrivalsPerDay: 1 });
      // Un martes que el periodo no incluye no divide entre cero.
      expect(stats.byWeekday[2]).toMatchObject({ arrivals: 0, arrivalsPerDay: 0 });
    });

    it('por profesional y por servicio pedido', () => {
      expect(stats.byStylist).toEqual([
        { stylistId: 'valeria', attended: 1, requested: 1, averageService: 30 },
        { stylistId: 'sara', attended: 1, requested: 0, averageService: 40 },
      ]);
      expect(stats.byService).toEqual([
        { serviceId: 'cut', requests: 2 },
        { serviceId: 'color', requests: 1 },
      ]);
    });

    it('solo saca conclusiones con muestras suficientes', () => {
      expect(stats.insights).toEqual([
        { kind: 'peak-hour', hour: 9, arrivals: 4 },
        { kind: 'slowest-hour', hour: 9, averageWait: 20 },
        { kind: 'busiest-weekday', weekday: 0, arrivalsPerDay: 5 },
      ]);
    });
  });

  it('cuánto aguantan las que se van, y a quién piden más', () => {
    const left = (minutes: number) =>
      fact({
        status: 'CANCELLED',
        preferredStylistId: 'sara',
        closedAt: new Date(at(YESTERDAY, '09:00').getTime() + minutes * 60_000),
      });

    const stats = summarizeQueue([left(10), left(20), left(30)], options());

    expect(stats.insights).toEqual(
      expect.arrayContaining([
        { kind: 'leave-after', minutes: 20, samples: 3 },
        { kind: 'most-requested', stylistId: 'sara', requested: 3 },
      ]),
    );
    expect(stats.byStylist).toEqual([
      { stylistId: 'sara', attended: 0, requested: 3, averageService: null },
    ]);
  });

  it('un periodo sin nadie da ceros, no errores', () => {
    const stats = summarizeQueue([], options());

    expect(stats).toMatchObject({
      arrivals: 0,
      abandonmentRate: null,
      byHour: [],
      insights: [],
      chargedTurns: 0,
    });
    expect(stats.revenue.toDecimalString()).toBe('0.00');
    expect(stats.byDay.map((day) => day.arrivals)).toEqual([0, 0]);
  });

  it('una atendida sin hora de sillón no cuenta para el tiempo de servicio', () => {
    const stats = summarizeQueue(
      [fact({ status: 'DONE', stylistId: 'sara', closedAt: at(YESTERDAY, '10:00') })],
      options(),
    );
    expect(stats.service.samples).toBe(0);
    expect(stats.byStylist[0]).toMatchObject({ attended: 1, averageService: null });
  });
});
