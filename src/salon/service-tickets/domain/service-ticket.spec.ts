import { DomainValidationError, InvalidStateTransitionError } from '@shared/domain/errors';

import { ServiceTicket } from './service-ticket.entity';

describe('ServiceTicket', () => {
  const NOW = new Date('2026-09-28T15:00:00.000Z');

  const register = (overrides: Partial<Parameters<typeof ServiceTicket.register>[0]> = {}) =>
    ServiceTicket.register({
      id: 'ticket-1',
      tenantId: 'tenant-1',
      stylistId: 'stylist-1',
      clientId: 'client-1',
      clientName: '  Lucía Pérez ',
      serviceIds: ['service-1', 'service-2'],
      now: NOW,
      actorId: 'user-stylist',
      ...overrides,
    });

  describe('registro', () => {
    it('nace pendiente, sin factura y con el nombre de la clienta limpio', () => {
      const ticket = register();

      expect(ticket.status).toBe('PENDING');
      expect(ticket.isPending).toBe(true);
      expect(ticket.invoiceId).toBeNull();
      expect(ticket.clientName).toBe('Lucía Pérez');
      expect(ticket.serviceIds).toEqual(['service-1', 'service-2']);
    });

    it('exige al menos un servicio', () => {
      expect(() => register({ serviceIds: [] })).toThrow(DomainValidationError);
    });

    it('rechaza un servicio repetido, que la factura no admitiría al cobrar', () => {
      expect(() => register({ serviceIds: ['service-1', 'service-1'] })).toThrow(
        DomainValidationError,
      );
    });

    it('exige saber a qué clienta se le hizo el servicio', () => {
      expect(() => register({ clientId: null, clientName: '   ' })).toThrow(DomainValidationError);
    });

    it('admite a una clienta de paso sin ficha', () => {
      const ticket = register({ clientId: null, clientName: 'Clienta de paso' });

      expect(ticket.clientId).toBeNull();
      expect(ticket.clientName).toBe('Clienta de paso');
    });
  });

  describe('cobro y anulación', () => {
    it('al cobrarse enlaza la factura que la justifica', () => {
      const ticket = register();
      ticket.markCharged('invoice-1', NOW, 'user-cashier');

      expect(ticket.status).toBe('CHARGED');
      expect(ticket.invoiceId).toBe('invoice-1');
      expect(ticket.chargedBy).toBe('user-cashier');
    });

    it('no se cobra dos veces', () => {
      const ticket = register();
      ticket.markCharged('invoice-1', NOW, 'user-cashier');

      expect(() => ticket.markCharged('invoice-2', NOW, 'user-cashier')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('una comanda cobrada no se anula: se anula la factura por su cauce', () => {
      const ticket = register();
      ticket.markCharged('invoice-1', NOW, 'user-cashier');

      expect(() => ticket.cancel('Error', NOW, 'user-cashier')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('la anulación exige motivo', () => {
      expect(() => register().cancel('  ', NOW, 'user-stylist')).toThrow(DomainValidationError);
    });

    it('si se anula su venta vuelve a caja, lista para cobrarse bien (ADR-0020)', () => {
      const ticket = register();
      ticket.markCharged('invoice-1', NOW, 'user-cashier');
      ticket.reopen(NOW, 'user-owner');

      expect(ticket.status).toBe('PENDING');
      expect(ticket.invoiceId).toBeNull();
      expect(ticket.chargedAt).toBeNull();
      ticket.markCharged('invoice-2', NOW, 'user-cashier');
      expect(ticket.invoiceId).toBe('invoice-2');
    });

    it('solo se reabre una comanda cobrada', () => {
      expect(() => register().reopen(NOW, 'user-owner')).toThrow(InvalidStateTransitionError);
    });

    it('una comanda anulada ya no se cobra', () => {
      const ticket = register();
      ticket.cancel('Clienta equivocada', NOW, 'user-stylist');

      expect(ticket.cancellationReason).toBe('Clienta equivocada');
      expect(() => ticket.markCharged('invoice-1', NOW, 'user-cashier')).toThrow(
        InvalidStateTransitionError,
      );
    });
  });
});
