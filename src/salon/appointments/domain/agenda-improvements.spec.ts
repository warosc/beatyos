import { TimeRange } from '@shared/domain/value-objects/time-range.vo';

import { AvailabilityService } from './availability.service';
import { AppointmentChangeRequest } from './change-request.entity';
import { composeReminderMessage, toInternationalPhone, whatsappLink } from './reminder-message';

describe('Solicitud de cambio de hora', () => {
  const NOW = new Date('2026-10-08T15:00:00.000Z');
  const open = (proposed = '2026-10-09T18:00:00.000Z') =>
    AppointmentChangeRequest.open({
      id: 'req-1',
      tenantId: 't',
      appointmentId: 'a-1',
      stylistId: 'sara',
      requestedBy: 'user-sara',
      currentStartsAt: new Date('2026-10-09T16:00:00.000Z'),
      proposedStartsAt: new Date(proposed),
      reason: '  la clienta pidió más tarde  ',
      now: NOW,
    });

  it('nace pendiente y guarda el motivo sin espacios sobrantes', () => {
    const request = open();
    expect(request.status).toBe('PENDING');
    expect(request.reason).toBe('la clienta pidió más tarde');
  });

  it('no admite proponer la misma hora ni una hora pasada', () => {
    expect(() => open('2026-10-09T16:00:00.000Z')).toThrow(
      expect.objectContaining({ code: 'CHANGE_REQUEST_SAME_TIME' }),
    );
    expect(() => open('2026-10-08T14:00:00.000Z')).toThrow(
      expect.objectContaining({ code: 'APPOINTMENT_IN_THE_PAST' }),
    );
  });

  it('se decide una sola vez', () => {
    const request = open();
    request.approve('encargada', NOW, ' ok ');
    expect(request.status).toBe('APPROVED');
    expect(request.decisionNote).toBe('ok');
    expect(() => request.reject('encargada', NOW)).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('solo la profesional que la pidió puede retirarla', () => {
    const request = open();
    expect(() => request.withdraw('otra', 'user-otra', NOW)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN_ACTION' }),
    );
    request.withdraw('sara', 'user-sara', NOW);
    expect(request.status).toBe('WITHDRAWN');
  });
});

describe('Teléfono para WhatsApp', () => {
  it.each([
    ['5555-1234', '+50255551234'],
    ['+502 5555 1234', '+50255551234'],
    ['(502) 5555 1234', '+50255551234'],
    ['0034 600 111 222', '+34600111222'],
    ['+34 600 111 222', '+34600111222'],
  ])('%s → %s', (raw, expected) => {
    expect(toInternationalPhone(raw, '502')).toBe(expected);
  });

  it.each([null, '', 'sin teléfono', '123'])('descarta %p', (raw) => {
    expect(toInternationalPhone(raw, '502')).toBeNull();
  });

  it('el enlace wa.me lleva el número sin adornos y el texto codificado', () => {
    expect(whatsappLink('+50255551234', 'Hola, Ana')).toBe(
      'https://wa.me/50255551234?text=Hola%2C%20Ana',
    );
  });
});

describe('Mensaje del recordatorio', () => {
  it('dice cuándo, con quién y qué, en la hora del salón, con el enlace', () => {
    const message = composeReminderMessage(
      {
        appointmentId: 'a',
        tenantId: 't',
        salonName: 'Salón Bella Vista',
        clientFirstName: 'Ana',
        clientPhone: null,
        stylistName: 'Sara Molina',
        serviceNames: ['Corte de señora'],
        // 9:30 en Guatemala (UTC-6).
        startsAt: new Date('2026-10-09T15:30:00.000Z'),
      },
      'http://localhost:3001/cita/abc',
      'America/Guatemala',
    );

    expect(message).toContain('Hola Ana');
    expect(message).toContain('Salón Bella Vista');
    expect(message).toContain('viernes, 9 de octubre');
    expect(message).toMatch(/9:30/);
    expect(message).toContain('Sara Molina (Corte de señora)');
    expect(message).toContain('http://localhost:3001/cita/abc');
  });
});

describe('Rejilla de huecos en la hora del salón', () => {
  it('con desfase de media hora, ofrece las horas en punto locales', () => {
    // India: UTC+5:30. Las 9:00 locales son las 3:30 UTC.
    const offset = 330 * 60_000;
    const window = TimeRange.create(
      new Date('2026-10-09T03:30:00.000Z'),
      new Date('2026-10-09T05:30:00.000Z'),
    );
    const slots = AvailabilityService.findSlots([window], [], {
      durationMinutes: 60,
      granularityMinutes: 60,
      gridOffsetMs: offset,
    });
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      '2026-10-09T03:30:00.000Z',
      '2026-10-09T04:30:00.000Z',
    ]);
  });

  it('sin desfase se comporta como antes', () => {
    const aligned = AvailabilityService.alignToGrid(
      new Date('2026-10-09T10:07:00.000Z'),
      15 * 60_000,
    );
    expect(aligned.toISOString()).toBe('2026-10-09T10:15:00.000Z');
  });
});
