import { DomainValidationError, InvalidStateTransitionError } from '@shared/domain/errors';

import { businessDateOf, byArrival, candidatesFor, QueueTurn } from './queue-turn.entity';

describe('QueueTurn (fila de espera)', () => {
  const NOW = new Date('2026-10-12T15:00:00.000Z');
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  const register = (overrides: Partial<Parameters<typeof QueueTurn.register>[0]> = {}) =>
    QueueTurn.register({
      id: 'turn-1',
      tenantId: 'tenant-1',
      businessDate: '2026-10-12',
      number: 1,
      clientName: 'Ana García',
      serviceIds: ['cut'],
      now: NOW,
      actorId: 'reception',
      ...overrides,
    });

  /** Profesional que sabe hacer lo que se le diga; sin lista, todo. */
  const attendant = (id: string, skills?: string[]) => ({
    id,
    canPerform: (serviceId: string) => !skills || skills.includes(serviceId),
  });

  describe('al anotarla', () => {
    it('entra en espera, sin profesional, con el nombre limpio y sin llamadas', () => {
      const turn = register({ clientName: '  Ana García  ', notes: '  ', clientId: 'client-1' });

      expect(turn.status).toBe('WAITING');
      expect(turn.clientName).toBe('Ana García');
      expect(turn.clientId).toBe('client-1');
      expect(turn.stylistId).toBeNull();
      expect(turn.notes).toBeNull();
      expect(turn.callCount).toBe(0);
      expect(turn.isActive).toBe(false);
      expect(turn.createdAt).toEqual(NOW);
      expect(turn.createdBy).toBe('reception');
    });

    it('admite no saber todavía qué servicio quiere', () => {
      expect(register({ serviceIds: undefined }).serviceIds).toEqual([]);
    });

    it('exige el nombre de la clienta', () => {
      expect(() => register({ clientName: '   ' })).toThrow(DomainValidationError);
    });

    it('rechaza servicios repetidos y más de veinte', () => {
      expect(() => register({ serviceIds: ['cut', 'cut'] })).toThrow(/repetido/);
      const many = Array.from({ length: 21 }, (_, index) => `service-${index}`);
      expect(() => register({ serviceIds: many })).toThrow(/como máximo/);
    });

    it('exige un número de turno positivo', () => {
      expect(() => register({ number: 0 })).toThrow(/positivo/);
      expect(() => register({ number: 1.5 })).toThrow(/positivo/);
    });
  });

  describe('nombre en la pantalla', () => {
    it('enseña el nombre y la inicial del siguiente, nunca el nombre completo', () => {
      expect(register({ clientName: 'ana maría garcía' }).publicName).toBe('ana M.');
      expect(register({ clientName: 'Ana García López' }).publicName).toBe('Ana G.');
    });

    it('con un solo nombre, solo ese', () => {
      expect(register({ clientName: 'Ana' }).publicName).toBe('Ana');
    });
  });

  describe('quién puede atenderla', () => {
    it('cualquiera que haga lo que pide, si no pidió a nadie', () => {
      const turn = register({ serviceIds: ['cut', 'color'] });

      expect(turn.canBeAttendedBy(attendant('sara'))).toBe(true);
      expect(turn.canBeAttendedBy(attendant('valeria', ['cut']))).toBe(false);
    });

    it('solo la profesional que pidió, aunque otra sepa hacerlo', () => {
      const turn = register({ preferredStylistId: 'sara' });

      expect(turn.canBeAttendedBy(attendant('sara'))).toBe(true);
      expect(turn.canBeAttendedBy(attendant('valeria'))).toBe(false);
      // La preferencia es para «llamar siguiente»; la habilidad, para todo.
      expect(turn.canBePerformedBy(attendant('valeria'))).toBe(true);
    });

    it('nadie, si ya no está en espera', () => {
      const turn = register();
      turn.call('sara', later(1), 'sara');
      expect(turn.canBeAttendedBy(attendant('valeria'))).toBe(false);
    });

    it('la siguiente es la primera en llegar que ella puede atender', () => {
      const first = register({ id: 'a', number: 1, preferredStylistId: 'valeria' });
      const second = register({ id: 'b', number: 2, serviceIds: ['color'], now: later(1) });
      const third = register({ id: 'c', number: 3, now: later(2) });

      const forSara = candidatesFor([third, first, second], attendant('sara', ['cut']));
      expect(forSara.map((turn) => turn.id)).toEqual(['c']);

      const forValeria = candidatesFor([third, second, first], attendant('valeria'));
      expect(forValeria.map((turn) => turn.id)).toEqual(['a', 'b', 'c']);
    });

    it('a la misma hora de llegada desempata el número', () => {
      const one = register({ id: 'a', number: 1 });
      const two = register({ id: 'b', number: 2 });
      expect([two, one].sort(byArrival).map((turn) => turn.number)).toEqual([1, 2]);
    });
  });

  describe('ciclo del turno', () => {
    it('llamar, volver a llamar, empezar y terminar con su comanda', () => {
      const turn = register();

      turn.call('sara', later(5), 'sara');
      expect(turn.status).toBe('CALLED');
      expect(turn.stylistId).toBe('sara');
      expect(turn.callCount).toBe(1);
      expect(turn.calledAt).toEqual(later(5));
      expect(turn.isActive).toBe(true);

      turn.recall(later(6), 'sara');
      expect(turn.callCount).toBe(2);
      expect(turn.calledAt).toEqual(later(6));

      turn.start(later(7), 'sara');
      expect(turn.status).toBe('IN_SERVICE');
      expect(turn.startedAt).toEqual(later(7));

      turn.finish('ticket-1', later(50), 'sara');
      expect(turn.status).toBe('DONE');
      expect(turn.serviceTicketId).toBe('ticket-1');
      expect(turn.startedAt).toEqual(later(7));
      expect(turn.closedAt).toEqual(later(50));
      expect(turn.updatedBy).toBe('sara');
      expect(turn.updatedAt).toEqual(later(50));
    });

    it('terminar sin haber pulsado «empezar» toma el final como inicio', () => {
      const turn = register();
      turn.call('sara', later(5), 'sara');

      turn.finish('ticket-1', later(40), 'sara');

      expect(turn.startedAt).toEqual(later(40));
    });

    it('terminar exige la comanda', () => {
      const turn = register();
      turn.call('sara', later(5), 'sara');
      expect(() => turn.finish('', later(40), 'sara')).toThrow(/comanda/);
    });

    it('no se termina un turno que nadie ha llamado', () => {
      expect(() => register().finish('ticket-1', later(1), 'sara')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('no vino: se cierra sin comanda', () => {
      const turn = register();
      turn.call('sara', later(5), 'sara');

      turn.markNoShow(later(10), 'sara');

      expect(turn.status).toBe('NO_SHOW');
      expect(turn.closedAt).toEqual(later(10));
      expect(turn.isActive).toBe(false);
    });

    it('devolverla a la fila conserva su llegada y sus llamadas', () => {
      const turn = register();
      turn.call('sara', later(5), 'sara');

      turn.requeue(later(6), 'sara');

      expect(turn.status).toBe('WAITING');
      expect(turn.stylistId).toBeNull();
      expect(turn.calledAt).toBeNull();
      expect(turn.createdAt).toEqual(NOW);
      // La siguiente llamada sube el contador y la pantalla vuelve a anunciarla.
      turn.call('valeria', later(8), 'valeria');
      expect(turn.callCount).toBe(2);
    });

    it('la primera llamada marca el final de la espera y no cambia después', () => {
      const turn = register();
      expect(turn.firstCalledAt).toBeNull();

      turn.call('sara', later(5), 'sara');
      turn.recall(later(7), 'sara');
      turn.requeue(later(8), 'sara');
      turn.call('valeria', later(12), 'valeria');

      expect(turn.firstCalledAt).toEqual(later(5));
      expect(turn.calledAt).toEqual(later(12));
    });

    it('cancelar guarda el motivo si lo hay', () => {
      const waiting = register();
      waiting.cancel('  Se fue  ', later(3), 'reception');
      expect(waiting.status).toBe('CANCELLED');
      expect(waiting.cancellationReason).toBe('Se fue');
      expect(waiting.closedAt).toEqual(later(3));

      const called = register({ id: 'turn-2' });
      called.call('sara', later(1), 'sara');
      called.cancel(null, later(3), 'reception');
      expect(called.cancellationReason).toBeNull();
    });

    it.each([
      ['volver a llamar en espera', (turn: QueueTurn) => turn.recall(later(1), null)],
      ['empezar en espera', (turn: QueueTurn) => turn.start(later(1), null)],
      ['marcar ausente en espera', (turn: QueueTurn) => turn.markNoShow(later(1), null)],
      ['devolver a la fila en espera', (turn: QueueTurn) => turn.requeue(later(1), null)],
    ])('no permite %s', (_label, act) => {
      expect(() => act(register())).toThrow(InvalidStateTransitionError);
    });

    it('una atendida no se llama, ni se cancela', () => {
      const turn = register();
      turn.call('sara', later(1), 'sara');
      turn.finish('ticket-1', later(30), 'sara');

      expect(() => turn.call('valeria', later(31), null)).toThrow(InvalidStateTransitionError);
      expect(() => turn.cancel(null, later(31), null)).toThrow(InvalidStateTransitionError);
    });
  });

  describe('día del salón', () => {
    it('se cuenta en la zona del salón, no en UTC', () => {
      // 23:30 en Guatemala del día 12 ya es día 13 en UTC.
      expect(businessDateOf(new Date('2026-10-13T05:30:00.000Z'), 'America/Guatemala')).toBe(
        '2026-10-12',
      );
      expect(businessDateOf(new Date('2026-10-13T06:30:00.000Z'), 'America/Guatemala')).toBe(
        '2026-10-13',
      );
    });
  });
});
