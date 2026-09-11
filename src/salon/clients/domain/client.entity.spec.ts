import { BusinessRuleViolationError, DomainValidationError } from '@shared/domain/errors';
import { Email, PersonName, Phone } from '@shared/domain/value-objects/contact.vo';
import { Money } from '@shared/domain/value-objects/money.vo';

import { Client } from './client.entity';

describe('Client', () => {
  const NOW = new Date('2026-09-02T10:00:00.000Z');
  const TENANT = '11111111-1111-7111-8111-111111111111';

  const create = (overrides: Partial<Parameters<typeof Client.create>[0]> = {}) =>
    Client.create({
      id: 'client-1',
      tenantId: TENANT,
      name: PersonName.create('Rosa', 'Iglesias'),
      email: Email.create('rosa@ejemplo.es'),
      currency: 'EUR',
      now: NOW,
      actorId: 'user-1',
      ...overrides,
    });

  describe('alta', () => {
    it('crea una ficha con los valores iniciales esperados', () => {
      const client = create();

      expect(client.name.full).toBe('Rosa Iglesias');
      expect(client.status).toBe('ACTIVE');
      expect(client.totalVisits).toBe(0);
      expect(client.totalSpent.isZero()).toBe(true);
      expect(client.loyaltyPoints).toBe(0);
      expect(client.marketingConsent).toBe(false);
    });

    it('exige al menos un correo o un teléfono', () => {
      // Sin vía de contacto no se puede avisar de un cambio de cita, que es el uso más
      // frecuente de la ficha.
      expect(() => create({ email: null, phone: null })).toThrow(DomainValidationError);
      expect(() => create({ email: null, phone: null })).toThrow(
        /correo electrónico o un teléfono/,
      );
    });

    it('acepta una ficha solo con teléfono', () => {
      const client = create({ email: null, phone: Phone.create('+34600111222') });
      expect(client.phone?.value).toBe('+34600111222');
      expect(client.email).toBeNull();
    });

    it('rechaza una fecha de nacimiento futura', () => {
      expect(() => create({ birthDate: new Date('2030-01-01') })).toThrow(DomainValidationError);
    });

    it('sella la fecha al otorgar el consentimiento comercial', () => {
      const client = create({ marketingConsent: true });

      // Sin fecha el consentimiento no es demostrable ante una inspección, así que se
      // sella junto con él y no puede existir uno sin la otra.
      expect(client.marketingConsent).toBe(true);
      expect(client.marketingConsentAt).toEqual(NOW);
    });

    it('no sella fecha si no se otorga consentimiento', () => {
      expect(create().marketingConsentAt).toBeNull();
    });
  });

  describe('modificación', () => {
    it('actualiza solo los campos indicados', () => {
      const client = create({ notes: 'Prefiere tonos fríos' });

      client.updateDetails({ city: 'Madrid' }, NOW, 'user-2');

      expect(client.city).toBe('Madrid');
      // `undefined` significa "no tocar"; sin esta distinción, una actualización parcial
      // borraría todo lo que el cliente de la API no reenvíe.
      expect(client.notes).toBe('Prefiere tonos fríos');
    });

    it('distingue entre no enviar un campo y enviarlo a null', () => {
      const client = create({ notes: 'Nota previa' });

      client.updateDetails({ notes: null }, NOW, 'user-2');

      expect(client.notes).toBeNull();
    });

    it('impide dejar la ficha sin ninguna vía de contacto', () => {
      const client = create({ email: Email.create('rosa@ejemplo.es'), phone: null });

      // La invariante del alta también rige aquí: si no, se podría vaciar el contacto en
      // dos pasos y esquivar la regla.
      expect(() => client.updateDetails({ email: null }, NOW, 'user-2')).toThrow(
        DomainValidationError,
      );
    });

    it('permite cambiar de correo a teléfono en la misma operación', () => {
      const client = create({ email: Email.create('rosa@ejemplo.es'), phone: null });

      client.updateDetails({ email: null, phone: Phone.create('+34600111222') }, NOW, 'user-2');

      expect(client.email).toBeNull();
      expect(client.phone?.value).toBe('+34600111222');
    });

    it('registra la autoría del cambio', () => {
      const client = create();
      client.updateDetails({ city: 'Sevilla' }, new Date('2026-09-03T08:00:00.000Z'), 'user-9');

      expect(client.audit.updatedBy).toBe('user-9');
      expect(client.audit.updatedAt).toEqual(new Date('2026-09-03T08:00:00.000Z'));
    });
  });

  describe('consentimiento comercial', () => {
    it('al retirarlo borra también la fecha', () => {
      const client = create({ marketingConsent: true });

      client.setMarketingConsent(false, NOW, 'user-2');

      // Conservar "consintió el 3 de marzo" junto a "no consiente" invita a que alguien
      // lo lea como permiso vigente. El histórico queda en AuditLog.
      expect(client.marketingConsent).toBe(false);
      expect(client.marketingConsentAt).toBeNull();
    });

    it('no cambia nada si el valor es el mismo', () => {
      const client = create({ marketingConsent: true });
      const before = client.audit.updatedAt;

      client.setMarketingConsent(true, new Date('2026-12-01'), 'user-2');

      expect(client.audit.updatedAt).toEqual(before);
    });
  });

  describe('bloqueo', () => {
    it('bloquea dejando constancia del motivo', () => {
      const client = create();

      client.block('Tres ausencias sin avisar', NOW, 'user-2');

      expect(client.status).toBe('BLOCKED');
      expect(client.notes).toContain('Tres ausencias sin avisar');
      expect(client.notes).toContain('2026-09-02');
    });

    it('no permite bloquear dos veces', () => {
      const client = create();
      client.block('Motivo', NOW, 'user-2');

      expect(() => client.block('Otro motivo', NOW, 'user-2')).toThrow(BusinessRuleViolationError);
    });

    it('desbloquea', () => {
      const client = create();
      client.block('Motivo', NOW, 'user-2');
      client.unblock(NOW, 'user-2');

      expect(client.status).toBe('ACTIVE');
    });
  });

  describe('métricas de visita', () => {
    it('acumula visitas y gasto', () => {
      const client = create();

      client.registerVisit(Money.fromDecimal('45.50', 'EUR'), NOW);
      client.registerVisit(Money.fromDecimal('30.00', 'EUR'), NOW);

      expect(client.totalVisits).toBe(2);
      expect(client.totalSpent.toDecimalString()).toBe('75.50');
      expect(client.lastVisitAt).toEqual(NOW);
    });

    it('el gasto acumulado no acumula error de coma flotante', () => {
      const client = create();
      for (let i = 0; i < 100; i += 1) {
        client.registerVisit(Money.fromDecimal('0.07', 'EUR'), NOW);
      }
      expect(client.totalSpent.toDecimalString()).toBe('7.00');
    });

    it('rechaza importes negativos', () => {
      const client = create();
      expect(() => client.registerVisit(Money.fromDecimal('-10.00', 'EUR'), NOW)).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('puntos de fidelidad', () => {
    it('suma y resta puntos', () => {
      const client = create();
      client.addLoyaltyPoints(100, NOW);
      client.addLoyaltyPoints(-30, NOW);

      expect(client.loyaltyPoints).toBe(70);
    });

    it('impide dejar el saldo en negativo', () => {
      const client = create();
      client.addLoyaltyPoints(10, NOW);

      expect(() => client.addLoyaltyPoints(-50, NOW)).toThrow(BusinessRuleViolationError);
      expect(client.loyaltyPoints).toBe(10);
    });

    it('rechaza fracciones de punto', () => {
      const client = create();
      expect(() => client.addLoyaltyPoints(1.5, NOW)).toThrow(DomainValidationError);
    });
  });

  describe('edad y cumpleaños', () => {
    it('calcula la edad en años cumplidos', () => {
      const client = create({ birthDate: new Date('1988-04-17T00:00:00.000Z') });
      expect(client.ageAt(NOW)).toBe(38);
    });

    it('no cuenta el año en curso si aún no ha cumplido', () => {
      // Sin este ajuste, quien cumple en diciembre aparecería un año mayor durante once
      // meses del año.
      const client = create({ birthDate: new Date('1988-12-31T00:00:00.000Z') });
      expect(client.ageAt(NOW)).toBe(37);
    });

    it('devuelve null si no consta la fecha', () => {
      expect(create().ageAt(NOW)).toBeNull();
    });

    it('detecta cumpleaños próximos', () => {
      const client = create({ birthDate: new Date('1990-09-10T00:00:00.000Z') });
      expect(client.hasBirthdayWithin(30, NOW)).toBe(true);
      expect(client.hasBirthdayWithin(3, NOW)).toBe(false);
    });

    it('cruza el fin de año al buscar cumpleaños próximos', () => {
      const december = new Date('2026-12-28T00:00:00.000Z');
      const client = create({ birthDate: new Date('1990-01-05T00:00:00.000Z') });

      // En diciembre hay que poder preparar las felicitaciones de enero.
      expect(client.hasBirthdayWithin(15, december)).toBe(true);
    });

    it('sin fecha de nacimiento nunca cumple años', () => {
      expect(create().hasBirthdayWithin(365, NOW)).toBe(false);
    });
  });

  describe('anonimización (RGPD)', () => {
    it('destruye los datos personales y conserva las métricas', () => {
      const client = create({
        phone: Phone.create('+34600111222'),
        birthDate: new Date('1988-04-17'),
        allergies: 'Alergia a la PPD',
        addressLine: 'Calle Mayor 1',
        city: 'Madrid',
        notes: 'Prefiere tonos fríos',
      });
      client.registerVisit(Money.fromDecimal('45.50', 'EUR'), NOW);

      client.anonymize(NOW, 'user-2');

      expect(client.name.firstName).toBe('Anónimo');
      expect(client.email).toBeNull();
      expect(client.phone).toBeNull();
      expect(client.birthDate).toBeNull();
      expect(client.addressLine).toBeNull();
      expect(client.notes).toBeNull();
      // Las alergias también se borran: son dato de salud, la categoría más protegida
      // del reglamento, y no hay base legal para conservarlas tras ejercer el derecho.
      expect(client.allergies).toBeNull();

      // Los agregados no identifican a nadie y su pérdida falsearía los informes
      // históricos del salón.
      expect(client.totalVisits).toBe(1);
      expect(client.totalSpent.toDecimalString()).toBe('45.50');
    });

    it('retira el consentimiento comercial', () => {
      const client = create({ marketingConsent: true });
      client.anonymize(NOW, 'user-2');

      expect(client.marketingConsent).toBe(false);
      expect(client.marketingConsentAt).toBeNull();
    });

    it('el seudónimo deriva del identificador y es estable', () => {
      const client = create({ id: 'abcdef-123456' });
      client.anonymize(NOW, 'user-2');

      expect(client.name.lastName).toBe('Cliente 123456');
    });

    it('no se puede anonimizar dos veces', () => {
      const client = create();
      client.anonymize(NOW, 'user-2');

      expect(() => client.anonymize(NOW, 'user-2')).toThrow(BusinessRuleViolationError);
    });

    it('deja la ficha inactiva', () => {
      const client = create();
      client.anonymize(NOW, 'user-2');

      expect(client.status).toBe('INACTIVE');
    });
  });
});
