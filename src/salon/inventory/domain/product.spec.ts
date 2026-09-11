import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import { InventoryMovement } from './inventory-movement.entity';
import { Product } from './product.entity';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-03T10:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

const aProduct = (overrides: Partial<Parameters<typeof Product.create>[0]> = {}) =>
  Product.create({
    id: 'product-1',
    tenantId: TENANT,
    sku: 'SH-ARG-500',
    name: 'Champú de argán 500 ml',
    price: gtq('120.00'),
    costPrice: gtq('60.00'),
    now: NOW,
    actorId: 'user-1',
    ...overrides,
  });

describe('Product', () => {
  describe('alta', () => {
    it('normaliza el SKU a mayúsculas', () => {
      expect(aProduct({ sku: '  sh-arg-500  ' }).sku).toBe('SH-ARG-500');
    });

    it('rechaza un SKU con caracteres que no admite el catálogo', () => {
      expect(() => aProduct({ sku: 'SH ARG/500' })).toThrow(DomainValidationError);
    });

    it('nace siempre con cero existencias', () => {
      // El stock solo se mueve por el ledger: aceptar una cantidad inicial aquí crearía
      // unidades sin un movimiento que las explique.
      expect(aProduct().stockOnHand).toBe(0);
    });

    it('aplica el IVA de Guatemala por defecto', () => {
      expect(aProduct().taxRate.value).toBe(12);
    });

    it('admite otro IVA cuando el producto lo lleva', () => {
      expect(aProduct({ taxRate: Percentage.create(0) }).taxRate.value).toBe(0);
    });

    it('rechaza un producto que ni se vende ni se usa en cabina', () => {
      expect(() => aProduct({ isRetail: false, isInternal: false })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rechaza trazar lotes sin llevar existencias', () => {
      expect(() => aProduct({ tracksBatches: true, trackStock: false })).toThrow(
        /control de existencias/,
      );
    });

    it('rechaza un coste en moneda distinta del precio', () => {
      expect(() => aProduct({ costPrice: Money.fromDecimal('60.00', 'USD') })).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('semáforo de existencias', () => {
    it('marca agotado en cero', () => {
      expect(aProduct().stockStatus).toBe('OUT');
    });

    it('marca bajo al llegar justo al punto de pedido', () => {
      // Estar en el mínimo ya es motivo de reposición: el mínimo es lo que hace falta para
      // aguantar hasta que llegue el pedido, no un umbral que se pueda rozar.
      const product = aProduct({ reorderPoint: 5 });
      product.applyDelta(5, NOW, 'user-1');

      expect(product.stockStatus).toBe('LOW');
    });

    it('marca disponible por encima del punto de pedido', () => {
      const product = aProduct({ reorderPoint: 5 });
      product.applyDelta(5.001, NOW, 'user-1');

      expect(product.stockStatus).toBe('AVAILABLE');
    });

    it('considera siempre disponible lo que no lleva control de existencias', () => {
      expect(aProduct({ trackStock: false, reorderPoint: 0 }).stockStatus).toBe('AVAILABLE');
    });

    it('calcula cuánto falta para llegar al mínimo', () => {
      const product = aProduct({ reorderPoint: 10 });
      product.applyDelta(3, NOW, 'user-1');

      expect(product.missingToReorderPoint).toBe(7);
    });

    it('no reclama nada cuando sobra existencia', () => {
      const product = aProduct({ reorderPoint: 2 });
      product.applyDelta(10, NOW, 'user-1');

      expect(product.missingToReorderPoint).toBe(0);
    });
  });

  describe('variación de existencias', () => {
    it('suma la entrada y devuelve el saldo', () => {
      const product = aProduct();

      expect(product.applyDelta(12, NOW, 'user-1')).toBe(12);
      expect(product.stockOnHand).toBe(12);
    });

    it('resta la salida', () => {
      const product = aProduct();
      product.applyDelta(12, NOW, 'user-1');

      expect(product.applyDelta(-4.5, NOW, 'user-1')).toBe(7.5);
    });

    it('rechaza la salida que dejaría existencias negativas', () => {
      const product = aProduct();
      product.applyDelta(2, NOW, 'user-1');

      expect(() => product.applyDelta(-3, NOW, 'user-1')).toThrow(BusinessRuleViolationError);
      expect(product.stockOnHand).toBe(2);
    });

    it('rechaza una variación de cero', () => {
      expect(() => aProduct().applyDelta(0, NOW, 'user-1')).toThrow(DomainValidationError);
    });

    it('rechaza mover existencias de un producto que no las lleva', () => {
      expect(() => aProduct({ trackStock: false }).applyDelta(1, NOW, 'user-1')).toThrow(
        /no lleva control de existencias/,
      );
    });

    it('redondea a la precisión de la columna', () => {
      // Restar 0,15 de 20 en coma flotante da 19,849999999999998. Sin redondear, esa cola
      // se acumula hasta que el recuento físico no cuadra por milésimas inexplicables.
      const product = aProduct();
      product.applyDelta(20, NOW, 'user-1');

      expect(product.applyDelta(-0.15, NOW, 'user-1')).toBe(19.85);
    });
  });

  describe('coste medio ponderado', () => {
    it('toma el coste de la primera entrada cuando no había existencias', () => {
      const product = aProduct({ costPrice: gtq('0.00') });
      product.applyReceiptCost(10, gtq('50.00'), NOW, 'user-1');

      expect(product.costPrice.toDecimalString()).toBe('50.00');
    });

    it('pondera por cantidad, no por número de compras', () => {
      // 100 unidades a 5,00 y 1 a 50,00 dan 5,45, no 27,50.
      const product = aProduct({ costPrice: gtq('5.00') });
      product.applyDelta(100, NOW, 'user-1');
      product.applyReceiptCost(1, gtq('50.00'), NOW, 'user-1');

      expect(product.costPrice.toDecimalString()).toBe('5.45');
    });

    it('promedia con las existencias previas, no con las resultantes', () => {
      // 10 a 60,00 más 10 a 80,00 dan 70,00. Aplicar la media sobre 20 unidades ya sumadas
      // diluiría el coste nuevo consigo mismo y daría una cifra sistemáticamente baja.
      const product = aProduct({ costPrice: gtq('60.00') });
      product.applyDelta(10, NOW, 'user-1');
      product.applyReceiptCost(10, gtq('80.00'), NOW, 'user-1');

      expect(product.costPrice.toDecimalString()).toBe('70.00');
    });

    it('rechaza una entrada en otra moneda', () => {
      expect(() =>
        aProduct().applyReceiptCost(1, Money.fromDecimal('50.00', 'USD'), NOW, 'user-1'),
      ).toThrow(DomainValidationError);
    });

    it('rechaza una cantidad no positiva', () => {
      expect(() => aProduct().applyReceiptCost(0, gtq('50.00'), NOW, 'user-1')).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('margen', () => {
    it('lo calcula sobre el precio de venta', () => {
      expect(aProduct({ price: gtq('100.00'), costPrice: gtq('60.00') }).marginPercentage()).toBe(
        40,
      );
    });

    it('no lo calcula en un producto gratuito', () => {
      expect(aProduct({ price: gtq('0.00'), isInternal: true }).marginPercentage()).toBeNull();
    });
  });

  describe('modificación', () => {
    it('impide dejar de controlar existencias con producto en la estantería', () => {
      // Desaparecerían del sistema unas unidades que siguen existiendo. Primero se ajustan
      // a cero, con su movimiento en el kardex.
      const product = aProduct();
      product.applyDelta(3, NOW, 'user-1');

      expect(() => product.update({ trackStock: false }, NOW, 'user-1')).toThrow(
        /Ajústelas a cero/,
      );
    });

    it('permite dejar de controlarlas cuando ya no queda nada', () => {
      const product = aProduct();
      product.update({ trackStock: false }, NOW, 'user-1');

      expect(product.trackStock).toBe(false);
    });

    it('impide cambiar de moneda', () => {
      expect(() =>
        aProduct().update({ price: Money.fromDecimal('120.00', 'USD') }, NOW, 'user-1'),
      ).toThrow(DomainValidationError);
    });

    it('impide dejar el producto sin uso', () => {
      expect(() => aProduct().update({ isRetail: false }, NOW, 'user-1')).toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('baja', () => {
    it('impide dar de baja producto con existencias', () => {
      const product = aProduct();
      product.applyDelta(1, NOW, 'user-1');

      expect(() => product.markDeleted(NOW, 'user-1')).toThrow(/quedan 1 unidades/);
    });

    it('desactiva y sella al dar de baja sin existencias', () => {
      const product = aProduct();
      product.markDeleted(NOW, 'user-1');

      expect(product.isDeleted).toBe(true);
      expect(product.isActive).toBe(false);
    });

    it('reactiva al restaurar', () => {
      const product = aProduct();
      product.markDeleted(NOW, 'user-1');
      product.markRestored(NOW, 'user-2');

      expect(product.isDeleted).toBe(false);
      expect(product.isActive).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------

describe('InventoryMovement', () => {
  const record = (overrides: Partial<Parameters<typeof InventoryMovement.record>[0]> = {}) =>
    InventoryMovement.record({
      id: 'movement-1',
      tenantId: TENANT,
      productId: 'product-1',
      type: 'PURCHASE_IN',
      quantityDelta: 10,
      balanceAfter: 10,
      now: NOW,
      actorId: 'user-1',
      ...overrides,
    });

  it('rechaza un movimiento de cero unidades', () => {
    expect(() => record({ quantityDelta: 0 })).toThrow(DomainValidationError);
  });

  it('rechaza una entrada con signo de salida', () => {
    // Casi siempre es un `-` de más en quien llama. Pararlo aquí evita descubrirlo
    // cuadrando el almacén a fin de mes.
    expect(() => record({ quantityDelta: -10 })).toThrow(/suma existencias/);
  });

  it('rechaza una salida con signo de entrada', () => {
    expect(() => record({ type: 'SALE_OUT', quantityDelta: 5, balanceAfter: 5 })).toThrow(
      /resta existencias/,
    );
  });

  it('admite un ajuste en cualquier sentido', () => {
    // Un recuento puede encontrar de más o de menos: es el único tipo de doble sentido.
    expect(record({ type: 'ADJUSTMENT', quantityDelta: -3, balanceAfter: 7 }).quantityDelta).toBe(
      -3,
    );
    expect(record({ type: 'ADJUSTMENT', quantityDelta: 3, balanceAfter: 13 }).quantityDelta).toBe(
      3,
    );
  });

  it('rechaza dejar existencias negativas', () => {
    expect(() => record({ type: 'ADJUSTMENT', quantityDelta: -3, balanceAfter: -1 })).toThrow(
      DomainValidationError,
    );
  });

  it('calcula el valor del movimiento sobre la cantidad absoluta', () => {
    const movement = record({
      type: 'SALE_OUT',
      quantityDelta: -2,
      balanceAfter: 8,
      unitCost: gtq('60.00'),
    });

    expect(movement.value?.toDecimalString()).toBe('120.00');
    expect(movement.isInbound).toBe(false);
  });

  it('no inventa un valor cuando no se conocía el coste', () => {
    expect(record().value).toBeNull();
  });

  it('no expone ningún método que modifique el asiento', () => {
    // El ledger es de solo anexión (ADR-0011): corregir un error se hace registrando el
    // movimiento contrario, no editando el equivocado. Si alguien añade un mutador, este
    // test lo señala antes de que el trigger de PostgreSQL lo rechace en producción.
    const mutators = ['update', 'consume', 'adjust', 'markDeleted', 'restore', 'save'];
    const surface = Object.getOwnPropertyNames(InventoryMovement.prototype);

    expect(surface.filter((name) => mutators.includes(name))).toEqual([]);
  });
});
