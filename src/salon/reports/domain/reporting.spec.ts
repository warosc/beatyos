import { DomainValidationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import {
  appointmentCounts,
  dailySales,
  occupancy,
  resolvePeriod,
  retentionRate,
  stylistPerformance,
  summarizeSales,
  topProducts,
  type AppointmentFact,
  type SaleFact,
  type SaleLineFact,
  type ScheduleFact,
} from './reporting';

const TZ = 'America/Guatemala';
const NOW = new Date('2026-09-03T12:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

const aSale = (overrides: Partial<SaleFact> = {}): SaleFact => ({
  invoiceId: 'inv-1',
  clientId: 'client-1',
  total: gtq('100.00'),
  issuedAt: NOW,
  ...overrides,
});

const aLine = (overrides: Partial<SaleLineFact> = {}): SaleLineFact => ({
  kind: 'SERVICE',
  productId: null,
  serviceId: 'srv-1',
  stylistId: null,
  stylistName: null,
  description: 'Corte',
  quantity: 1,
  lineSubtotal: gtq('100.00'),
  lineTotal: gtq('112.00'),
  commissionAmount: gtq('0.00'),
  ...overrides,
});

describe('resolvePeriod', () => {
  it('usa la ventana por defecto cuando no se indican fechas', () => {
    const period = resolvePeriod({ fallbackDays: 30, now: NOW });

    expect(period.to).toEqual(NOW);
    expect(period.from).toEqual(new Date('2026-08-04T12:00:00.000Z'));
  });

  it('rechaza un rango invertido', () => {
    expect(() =>
      resolvePeriod({ from: '2026-09-10', to: '2026-09-01', fallbackDays: 30, now: NOW }),
    ).toThrow(DomainValidationError);
  });

  it('rechaza fechas ilegibles', () => {
    expect(() => resolvePeriod({ from: 'ayer', fallbackDays: 30, now: NOW })).toThrow(
      DomainValidationError,
    );
  });

  it('rechaza rangos mayores de un año', () => {
    // Un informe sin límite acaba pidiendo el histórico entero, y esa consulta tumba la
    // base en el momento en que alguien la lanza desde el móvil un sábado.
    expect(() =>
      resolvePeriod({ from: '2024-01-01', to: '2026-01-01', fallbackDays: 30, now: NOW }),
    ).toThrow(/366 días/);
  });

  it('admite exactamente un año', () => {
    expect(() =>
      resolvePeriod({ from: '2026-01-01', to: '2026-12-01', fallbackDays: 30, now: NOW }),
    ).not.toThrow();
  });
});

describe('summarizeSales', () => {
  it('suma el total y calcula el ticket medio', () => {
    const summary = summarizeSales(
      [aSale({ total: gtq('100.00') }), aSale({ total: gtq('50.00') })],
      'GTQ',
    );

    expect(summary.total.toDecimalString()).toBe('150.00');
    expect(summary.tickets).toBe(2);
    expect(summary.averageTicket.toDecimalString()).toBe('75.00');
  });

  it('devuelve cero y no NaN sin ventas', () => {
    // Una división por cero que se cuela hasta la interfaz se pinta como «NaN Q» y quien lo
    // ve piensa que el sistema está roto.
    const summary = summarizeSales([], 'GTQ');

    expect(summary.averageTicket.toDecimalString()).toBe('0.00');
    expect(summary.total.toDecimalString()).toBe('0.00');
  });

  it('redondea el ticket medio al céntimo', () => {
    const summary = summarizeSales(
      [
        aSale({ total: gtq('10.00') }),
        aSale({ total: gtq('10.00') }),
        aSale({ total: gtq('10.01') }),
      ],
      'GTQ',
    );

    expect(summary.averageTicket.toDecimalString()).toBe('10.00');
  });
});

describe('dailySales', () => {
  const range = {
    from: new Date('2026-09-01T06:00:00.000Z'),
    to: new Date('2026-09-04T06:00:00.000Z'),
  };

  it('agrupa por el día del salón, no por el día UTC', () => {
    // Guatemala es UTC−6. Una venta a las 19:00 locales del día 2 son las 01:00 UTC del día
    // 3. Agrupar por la fecha UTC la mandaría al día siguiente, y con ella casi toda la
    // facturación de las tardes.
    const series = dailySales(
      [aSale({ issuedAt: new Date('2026-09-03T01:00:00.000Z'), total: gtq('80.00') })],
      range,
      TZ,
      'GTQ',
    );

    const dia2 = series.find((item) => item.date === '2026-09-02');
    const dia3 = series.find((item) => item.date === '2026-09-03');

    expect(dia2?.total.toDecimalString()).toBe('80.00');
    expect(dia3?.total.toDecimalString()).toBe('0.00');
  });

  it('devuelve la serie completa, con los días cerrados a cero', () => {
    // Omitirlos haría que un gráfico de líneas uniera el lunes con el jueves en recta y
    // aparentara una caída suave donde hubo tres días cerrados.
    const series = dailySales([], range, TZ, 'GTQ');

    expect(series.map((item) => item.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(series.every((item) => item.total.isZero())).toBe(true);
  });

  it('acumula varias ventas del mismo día', () => {
    const series = dailySales(
      [
        aSale({ issuedAt: new Date('2026-09-02T16:00:00.000Z'), total: gtq('30.00') }),
        aSale({ issuedAt: new Date('2026-09-02T20:00:00.000Z'), total: gtq('45.50') }),
      ],
      range,
      TZ,
      'GTQ',
    );

    expect(series.find((item) => item.date === '2026-09-02')?.total.toDecimalString()).toBe(
      '75.50',
    );
  });
});

describe('topProducts', () => {
  it('ordena por unidades vendidas', () => {
    const ranked = topProducts(
      [
        aLine({ kind: 'PRODUCT', productId: 'p-1', description: 'Champú', quantity: 2 }),
        aLine({ kind: 'PRODUCT', productId: 'p-2', description: 'Tinte', quantity: 5 }),
      ],
      'GTQ',
    );

    expect(ranked.map((item) => item.id)).toEqual(['p-2', 'p-1']);
  });

  it('agrupa las líneas del mismo producto', () => {
    const ranked = topProducts(
      [
        aLine({ kind: 'PRODUCT', productId: 'p-1', quantity: 2, lineTotal: gtq('40.00') }),
        aLine({ kind: 'PRODUCT', productId: 'p-1', quantity: 3, lineTotal: gtq('60.00') }),
      ],
      'GTQ',
    );

    expect(ranked[0]).toMatchObject({ quantity: 5 });
    expect(ranked[0].revenue.toDecimalString()).toBe('100.00');
  });

  it('ignora las líneas de servicio', () => {
    expect(topProducts([aLine({ kind: 'SERVICE' })], 'GTQ')).toEqual([]);
  });

  it('desempata por nombre para que el orden sea estable', () => {
    // Sin desempate, dos productos con las mismas ventas bailarían de posición entre
    // recargas sin que nada haya cambiado.
    const ranked = topProducts(
      [
        aLine({ kind: 'PRODUCT', productId: 'p-b', description: 'Beta', quantity: 3 }),
        aLine({ kind: 'PRODUCT', productId: 'p-a', description: 'Alfa', quantity: 3 }),
      ],
      'GTQ',
    );

    expect(ranked.map((item) => item.name)).toEqual(['Alfa', 'Beta']);
  });

  it('recorta al límite pedido', () => {
    const lines = Array.from({ length: 8 }, (_, index) =>
      aLine({ kind: 'PRODUCT', productId: `p-${index}`, quantity: index + 1 }),
    );

    expect(topProducts(lines, 'GTQ', 3)).toHaveLength(3);
  });
});

describe('stylistPerformance', () => {
  it('atribuye solo los servicios, no los productos del ticket', () => {
    // Un producto que la recepcionista adjunta al ticket no es trabajo de quien atendió, y
    // atribuírselo inflaría su cifra con ventas que no ha hecho.
    const ranked = stylistPerformance(
      [
        aLine({ stylistId: 's-1', stylistName: 'Marta', lineSubtotal: gtq('100.00') }),
        aLine({
          kind: 'PRODUCT',
          productId: 'p-1',
          stylistId: 's-1',
          lineSubtotal: gtq('500.00'),
        }),
      ],
      'GTQ',
    );

    expect(ranked[0].revenue.toDecimalString()).toBe('100.00');
  });

  it('la comisión de un producto sí cuenta, aunque no sume a la facturación de servicios', () => {
    // La estilista no "presta" un producto, pero si lo vende sí se gana su comisión: son dos
    // preguntas distintas (cuánto factura en servicios vs. cuánto se le debe en total).
    const ranked = stylistPerformance(
      [
        aLine({ stylistId: 's-1', stylistName: 'Marta', commissionAmount: gtq('20.00') }),
        aLine({
          kind: 'PRODUCT',
          productId: 'p-1',
          stylistId: 's-1',
          commissionAmount: gtq('5.00'),
        }),
      ],
      'GTQ',
    );

    expect(ranked[0].commission.toDecimalString()).toBe('25.00');
    expect(ranked[0].services).toBe(1);
  });

  it('acumula la comisión congelada en cada línea', () => {
    const ranked = stylistPerformance(
      [
        aLine({ stylistId: 's-1', stylistName: 'Marta', commissionAmount: gtq('20.00') }),
        aLine({ stylistId: 's-1', stylistName: 'Marta', commissionAmount: gtq('12.50') }),
      ],
      'GTQ',
    );

    expect(ranked[0].commission.toDecimalString()).toBe('32.50');
    expect(ranked[0].services).toBe(2);
  });

  it('ignora las líneas sin profesional asignado', () => {
    expect(stylistPerformance([aLine({ stylistId: null })], 'GTQ')).toEqual([]);
  });

  it('ordena por facturación', () => {
    const ranked = stylistPerformance(
      [
        aLine({ stylistId: 's-1', stylistName: 'Ana', lineSubtotal: gtq('50.00') }),
        aLine({ stylistId: 's-2', stylistName: 'Berta', lineSubtotal: gtq('90.00') }),
      ],
      'GTQ',
    );

    expect(ranked.map((item) => item.name)).toEqual(['Berta', 'Ana']);
  });
});

describe('retentionRate', () => {
  it('mide qué porcentaje de clientas volvió dentro del periodo', () => {
    const rate = retentionRate([
      aSale({ clientId: 'c-1' }),
      aSale({ clientId: 'c-1' }),
      aSale({ clientId: 'c-2' }),
    ]);

    expect(rate).toBe(50);
  });

  it('no cuenta las ventas sin clienta identificada', () => {
    // No se puede saber si esa persona volvió.
    expect(retentionRate([aSale({ clientId: null }), aSale({ clientId: null })])).toBe(0);
  });

  it('devuelve cero sin ventas', () => {
    expect(retentionRate([])).toBe(0);
  });

  it('devuelve cien cuando todas repitieron', () => {
    expect(retentionRate([aSale({ clientId: 'c-1' }), aSale({ clientId: 'c-1' })])).toBe(100);
  });
});

describe('occupancy', () => {
  const schedule = (dayOfWeek: number, minutes: number): ScheduleFact => ({
    dayOfWeek,
    startMinutes: 9 * 60,
    endMinutes: 9 * 60 + minutes,
  });

  const appointment = (start: string, end: string, status = 'CONFIRMED'): AppointmentFact => ({
    startsAt: new Date(start),
    endsAt: new Date(end),
    status,
    isBlocking: status !== 'CANCELLED' && status !== 'NO_SHOW',
  });

  /** Jueves 3 de septiembre de 2026 en hora de Guatemala. */
  const oneDay = {
    from: new Date('2026-09-03T06:00:00.000Z'),
    to: new Date('2026-09-04T06:00:00.000Z'),
  };

  it('calcula el porcentaje sobre la capacidad del día', () => {
    // Jueves es 4 en `getDay()`. 480 minutos de capacidad y 120 vendidos: 25 %.
    const result = occupancy(
      [appointment('2026-09-03T15:00:00.000Z', '2026-09-03T17:00:00.000Z')],
      [schedule(4, 480)],
      oneDay,
      TZ,
    );

    expect(result.capacityMinutes).toBe(480);
    expect(result.bookedMinutes).toBe(120);
    expect(result.rate).toBe(25);
  });

  it('usa el día de la semana del salón, no el UTC', () => {
    // El jueves 3 empieza a las 06:00 UTC. Con `getUTCDay()` sobre el inicio del rango se
    // leería jueves, pero al recorrer madrugadas el desplazamiento de seis horas hace que
    // un día local se lea como el siguiente en UTC. Aquí el horario de miércoles no debe
    // contar y el de jueves sí.
    const result = occupancy([], [schedule(3, 999), schedule(4, 480)], oneDay, TZ);

    expect(result.capacityMinutes).toBe(480);
  });

  it('no cuenta las canceladas ni las que no se presentaron', () => {
    const result = occupancy(
      [
        appointment('2026-09-03T15:00:00.000Z', '2026-09-03T17:00:00.000Z', 'CANCELLED'),
        appointment('2026-09-03T17:00:00.000Z', '2026-09-03T18:00:00.000Z', 'NO_SHOW'),
      ],
      [schedule(4, 480)],
      oneDay,
      TZ,
    );

    expect(result.bookedMinutes).toBe(0);
  });

  it('devuelve cero si nadie tiene horario', () => {
    const result = occupancy(
      [appointment('2026-09-03T15:00:00.000Z', '2026-09-03T17:00:00.000Z')],
      [],
      oneDay,
      TZ,
    );

    expect(result.rate).toBe(0);
  });

  it('recorta al cien por cien', () => {
    // Un solapamiento heredado puede dar 103 %, y una ocupación superior al total es una
    // cifra que nadie sabe interpretar.
    const result = occupancy(
      [appointment('2026-09-03T14:00:00.000Z', '2026-09-04T02:00:00.000Z')],
      [schedule(4, 60)],
      oneDay,
      TZ,
    );

    expect(result.rate).toBe(100);
  });

  it('acumula la capacidad de varios profesionales', () => {
    const result = occupancy([], [schedule(4, 480), schedule(4, 240)], oneDay, TZ);

    expect(result.capacityMinutes).toBe(720);
  });
});

describe('appointmentCounts', () => {
  it('cuenta las citas por estado', () => {
    const counts = appointmentCounts([
      { startsAt: NOW, endsAt: NOW, status: 'COMPLETED', isBlocking: true },
      { startsAt: NOW, endsAt: NOW, status: 'COMPLETED', isBlocking: true },
      { startsAt: NOW, endsAt: NOW, status: 'CANCELLED', isBlocking: false },
    ]);

    expect(counts).toEqual({ COMPLETED: 2, CANCELLED: 1 });
  });

  it('devuelve un objeto vacío sin citas', () => {
    expect(appointmentCounts([])).toEqual({});
  });
});
