import { BusinessRuleViolationError, DomainValidationError } from '@shared/domain/errors';
import { Money } from '@shared/domain/value-objects/money.vo';
import { Percentage } from '@shared/domain/value-objects/time-range.vo';

import { Category } from './category.entity';
import { Service } from './service.entity';

const NOW = new Date('2026-09-02T10:00:00.000Z');
const TENANT = '11111111-1111-7111-8111-111111111111';

describe('Service', () => {
  const create = (overrides: Partial<Parameters<typeof Service.create>[0]> = {}): Service =>
    Service.create({
      id: 'svc-1',
      tenantId: TENANT,
      code: 'COR-M',
      name: 'Corte de señora',
      durationMinutes: 45,
      price: Money.fromDecimal('25.00', 'EUR'),
      now: NOW,
      actorId: 'admin',
      ...overrides,
    });

  describe('alta', () => {
    it('crea un servicio activo y reservable', () => {
      const service = create();

      expect(service.isActive).toBe(true);
      expect(service.isBookable()).toBe(true);
      expect(service.isBookableOnline).toBe(true);
      expect(service.taxRate.value).toBe(12);
      expect(service.consumables).toEqual([]);
    });

    it('normaliza el código a mayúsculas', () => {
      expect(create({ code: ' cor-m ' }).code).toBe('COR-M');
    });

    it('rechaza códigos mal formados', () => {
      expect(() => create({ code: 'a' })).toThrow(DomainValidationError);
      expect(() => create({ code: 'código con espacios' })).toThrow(DomainValidationError);
      expect(() => create({ code: '' })).toThrow(DomainValidationError);
    });

    it('rechaza un nombre vacío', () => {
      expect(() => create({ name: '   ' })).toThrow(/nombre del servicio/);
    });

    it('rechaza duraciones imposibles', () => {
      expect(() => create({ durationMinutes: 0 })).toThrow(DomainValidationError);
      expect(() => create({ durationMinutes: -30 })).toThrow(DomainValidationError);
      expect(() => create({ durationMinutes: 45.5 })).toThrow(DomainValidationError);
    });

    it('rechaza una duración mayor que una jornada', () => {
      // Casi siempre es un error de tecleo —minutos donde se querían poner horas— y sin
      // esta comprobación bloquearía la agenda de una profesional durante días.
      expect(() => create({ durationMinutes: 600 })).toThrow(/8 horas/);
    });

    it('rechaza un precio negativo', () => {
      expect(() => create({ price: Money.fromDecimal('-10.00', 'EUR') })).toThrow(
        DomainValidationError,
      );
    });

    it('admite un servicio gratuito', () => {
      // Un retoque de garantía o una primera consulta valen cero y siguen ocupando agenda.
      expect(() => create({ price: Money.zero('EUR') })).not.toThrow();
    });
  });

  describe('duración y margen', () => {
    it('el hueco de agenda es atención más margen de limpieza', () => {
      const service = create({ durationMinutes: 45, bufferMinutes: 15 });

      expect(service.durationMinutes).toBe(45);
      expect(service.bufferMinutes).toBe(15);
      // Confundir ambos produce el salón que acumula diez minutos de retraso por cita
      // hasta perder una hora entera por la tarde.
      expect(service.blockedMinutes).toBe(60);
    });

    it('sin margen declarado el hueco es solo la atención', () => {
      expect(create({ durationMinutes: 45 }).blockedMinutes).toBe(45);
    });

    it('rechaza márgenes negativos o desmesurados', () => {
      expect(() => create({ bufferMinutes: -5 })).toThrow(DomainValidationError);
      expect(() => create({ bufferMinutes: 121 })).toThrow(DomainValidationError);
    });
  });

  describe('precio e impuestos', () => {
    it('calcula el impuesto y el precio final', () => {
      const service = create({ price: Money.fromDecimal('25.00', 'EUR') });

      // IVA de Guatemala: 25,00 × 12% = 3,00.
      expect(service.taxAmount.toDecimalString()).toBe('3.00');
      expect(service.priceWithTax.toDecimalString()).toBe('28.00');
    });

    it('el cálculo no arrastra error de coma flotante', () => {
      const service = create({
        price: Money.fromDecimal('45.50', 'EUR'),
        taxRate: Percentage.create(21),
      });

      expect(service.taxAmount.toDecimalString()).toBe('9.56');
      expect(service.priceWithTax.toDecimalString()).toBe('55.06');
    });

    it('admite un tipo impositivo distinto', () => {
      const service = create({ taxRate: Percentage.create(10) });
      expect(service.taxAmount.toDecimalString()).toBe('2.50');
    });

    it('cambiar el precio es una operación con nombre propio', () => {
      const service = create();

      service.changePrice(Money.fromDecimal('30.00', 'EUR'), NOW, 'admin');

      expect(service.price.toDecimalString()).toBe('30.00');
    });

    it('no se puede cambiar la moneda de un servicio', () => {
      const service = create();

      expect(() => service.changePrice(Money.fromDecimal('30.00', 'USD'), NOW, 'admin')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rechaza un precio negativo al cambiarlo', () => {
      expect(() => create().changePrice(Money.fromDecimal('-1.00', 'EUR'), NOW, 'admin')).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('ciclo de vida', () => {
    it('retirar del catálogo no borra: deja de ofrecerse', () => {
      const service = create();

      service.deactivate(NOW, 'admin');

      expect(service.isActive).toBe(false);
      expect(service.isBookable()).toBe(false);
      // Las citas y facturas que lo referencian siguen siendo consultables.
      expect(service.isDeleted).toBe(false);
    });

    it('se puede volver a ofrecer', () => {
      const service = create();
      service.deactivate(NOW, 'admin');
      service.activate(NOW, 'admin');

      expect(service.isBookable()).toBe(true);
    });

    it('actualiza solo lo indicado', () => {
      const service = create({ description: 'Incluye lavado' });

      service.updateDetails({ durationMinutes: 60 }, NOW, 'admin');

      expect(service.durationMinutes).toBe(60);
      expect(service.description).toBe('Incluye lavado');
    });

    it('valida al actualizar igual que al crear', () => {
      const service = create();

      expect(() => service.updateDetails({ durationMinutes: 0 }, NOW, 'admin')).toThrow(
        DomainValidationError,
      );
      expect(() => service.updateDetails({ name: '  ' }, NOW, 'admin')).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('escandallo', () => {
    it('registra los productos que consume', () => {
      const service = create();

      service.replaceConsumables(
        [
          { productId: 'prd-tinte', quantity: 0.15 },
          { productId: 'prd-oxidante', quantity: 0.15 },
        ],
        NOW,
        'admin',
      );

      // Sin esto, el margen del servicio se calcularía como si el tinte fuese gratis.
      expect(service.consumables).toHaveLength(2);
    });

    it('admite cantidades fraccionarias', () => {
      const service = create();
      service.replaceConsumables([{ productId: 'prd-tinte', quantity: 0.15 }], NOW, 'admin');

      expect(service.consumables[0].quantity).toBe(0.15);
    });

    it('rechaza un producto repetido', () => {
      const service = create();

      expect(() =>
        service.replaceConsumables(
          [
            { productId: 'prd-tinte', quantity: 0.1 },
            { productId: 'prd-tinte', quantity: 0.2 },
          ],
          NOW,
          'admin',
        ),
      ).toThrow(DomainValidationError);
    });

    it('rechaza cantidades no positivas', () => {
      const service = create();

      expect(() =>
        service.replaceConsumables([{ productId: 'prd-tinte', quantity: 0 }], NOW, 'admin'),
      ).toThrow(DomainValidationError);
    });
  });
});

describe('Category', () => {
  const create = (overrides: Partial<Parameters<typeof Category.create>[0]> = {}): Category =>
    Category.create({
      id: 'cat-1',
      tenantId: TENANT,
      kind: 'SERVICE',
      name: 'Peluquería',
      now: NOW,
      actorId: 'admin',
      ...overrides,
    });

  describe('alta', () => {
    it('genera el slug a partir del nombre', () => {
      expect(create({ name: 'Peluquería' }).slug).toBe('peluqueria');
    });

    it('descompone los acentos en lugar de descartarlos', () => {
      // Filtrar sin descomponer primero produciría `coloraci-n`.
      expect(create({ name: 'Coloración y Mechas' }).slug).toBe('coloracion-y-mechas');
      expect(create({ name: 'Uñas & Manicura' }).slug).toBe('unas-manicura');
    });

    it('admite un slug explícito', () => {
      expect(create({ name: 'Peluquería', slug: 'hair' }).slug).toBe('hair');
    });

    it('rechaza un nombre del que no sale ningún slug', () => {
      expect(() => create({ name: '###' })).toThrow(DomainValidationError);
    });

    it('rechaza un nombre vacío', () => {
      expect(() => create({ name: '   ' })).toThrow(DomainValidationError);
    });

    it('nace como raíz y activa', () => {
      const category = create();
      expect(category.isRoot).toBe(true);
      expect(category.isActive).toBe(true);
    });
  });

  describe('árbol', () => {
    it('se mueve bajo otra categoría', () => {
      const category = create();

      category.moveTo('cat-padre', [], NOW, 'admin');

      expect(category.parentId).toBe('cat-padre');
      expect(category.isRoot).toBe(false);
    });

    it('vuelve a ser raíz', () => {
      const category = create({ parentId: 'cat-padre' });
      category.moveTo(null, [], NOW, 'admin');

      expect(category.isRoot).toBe(true);
    });

    it('no puede ser su propia madre', () => {
      expect(() => create().moveTo('cat-1', [], NOW, 'admin')).toThrow(BusinessRuleViolationError);
    });

    it('no puede moverse dentro de una descendiente suya', () => {
      const category = create();

      // Un ciclo dejaría el árbol irrecorrible: al pintar el menú, recursión infinita.
      expect(() => category.moveTo('cat-hija', ['cat-1'], NOW, 'admin')).toThrow(
        /CATEGORY_CYCLE|descendientes/,
      );
    });

    it('respeta el límite de profundidad', () => {
      const category = create();

      expect(() => category.moveTo('cat-nieta', ['cat-raiz', 'cat-hija'], NOW, 'admin')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('admite hasta el penúltimo nivel', () => {
      expect(() => create().moveTo('cat-hija', ['cat-raiz'], NOW, 'admin')).not.toThrow();
    });
  });

  describe('tipo', () => {
    it('una categoría de servicios no acepta productos', () => {
      const category = create({ kind: 'SERVICE' });

      expect(category.accepts('SERVICE')).toBe(true);
      expect(category.accepts('PRODUCT')).toBe(false);
    });
  });

  describe('modificación', () => {
    it('renombrar NO cambia el slug', () => {
      const category = create({ name: 'Peluquería' });

      category.updateDetails({ name: 'Peluquería y Estética' }, NOW, 'admin');

      // El slug puede estar en una URL pública que dejaría de funcionar. Cambiarlo es una
      // decisión explícita.
      expect(category.name).toBe('Peluquería y Estética');
      expect(category.slug).toBe('peluqueria');
    });

    it('permite cambiar el slug a propósito', () => {
      const category = create();
      category.updateDetails({ slug: 'Nuevo Slug' }, NOW, 'admin');

      expect(category.slug).toBe('nuevo-slug');
    });

    it('desactiva y reactiva', () => {
      const category = create();

      category.setActive(false, NOW, 'admin');
      expect(category.isActive).toBe(false);

      category.setActive(true, NOW, 'admin');
      expect(category.isActive).toBe(true);
    });
  });
});
