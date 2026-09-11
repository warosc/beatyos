import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Producto de inventario (ADR-0011, ADR-0012).
 *
 * El agregado guarda `stockOnHand`, pero **no es la fuente de verdad**: lo es el ledger de
 * movimientos. Esta cifra es una caché materializada que existe porque pintar la pantalla
 * de inventario sumando el ledger completo de cada producto sería inviable en cuanto el
 * salón lleve un año abierto.
 *
 * Que sea caché tiene una consecuencia práctica que se olvida con facilidad: **la caché no
 * se calcula, se aplica**. Leer `stockOnHand`, sumarle una cantidad y escribir el resultado
 * es un lost update esperando a ocurrir, y por eso `applyDelta` recibe la variación y no el
 * valor final. Cerrar del todo la ventana de carrera exige que el `UPDATE` sea condicional
 * en la base de datos; esto es la mitad de dominio de esa pareja.
 */

export type ProductUnitValue = 'UNIT' | 'MILLILITER' | 'LITER' | 'GRAM' | 'KILOGRAM';

export type StockStatus = 'AVAILABLE' | 'LOW' | 'OUT';

export interface ProductProps {
  readonly tenantId: string;
  readonly categoryId: string | null;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly brand: string | null;
  readonly price: Money;
  /** Coste medio ponderado. Con lotes deja de usarse para valorar salidas (ADR-0012). */
  readonly costPrice: Money;
  readonly taxRate: Percentage;
  readonly unit: ProductUnitValue;
  readonly stockOnHand: number;
  readonly reorderPoint: number;
  readonly reorderQuantity: number;
  readonly isRetail: boolean;
  readonly isInternal: boolean;
  readonly isActive: boolean;
  readonly trackStock: boolean;
  readonly tracksBatches: boolean;
  readonly audit: AuditMetadata;
}

const QUANTITY_EPSILON = 0.0005;
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,49}$/;

/** IVA general de Guatemala. Un producto puede llevar otro, pero este es el habitual. */
const DEFAULT_TAX_RATE = 12;

export class Product extends Entity {
  private constructor(
    id: string,
    private props: ProductProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    sku: string;
    name: string;
    price: Money;
    categoryId?: string | null;
    barcode?: string | null;
    description?: string | null;
    brand?: string | null;
    costPrice?: Money;
    taxRate?: Percentage;
    unit?: ProductUnitValue;
    reorderPoint?: number;
    reorderQuantity?: number;
    isRetail?: boolean;
    isInternal?: boolean;
    trackStock?: boolean;
    tracksBatches?: boolean;
    now: Date;
    actorId: string | null;
  }): Product {
    const sku = normalizeSku(params.sku);
    const name = requireText(params.name, 'name', 'El nombre del producto es obligatorio');

    if (params.price.isNegative()) {
      throw new DomainValidationError('El precio no puede ser negativo', 'price');
    }

    const costPrice = params.costPrice ?? Money.zero(params.price.currency);
    if (costPrice.isNegative()) {
      throw new DomainValidationError('El coste no puede ser negativo', 'costPrice');
    }
    if (costPrice.currency !== params.price.currency) {
      throw new DomainValidationError(
        `El coste está en ${costPrice.currency} y el precio en ${params.price.currency}`,
        'costPrice',
      );
    }

    // Un producto que no se vende ni se usa en cabina no tiene ningún papel en el salón, y
    // dejarlo entrar solo consigue que aparezca en listados donde nadie sabe qué hace.
    const isRetail = params.isRetail ?? true;
    const isInternal = params.isInternal ?? false;
    if (!isRetail && !isInternal) {
      throw new BusinessRuleViolationError(
        'PRODUCT_HAS_NO_USE',
        'Un producto debe venderse al público, usarse en cabina, o ambas cosas',
      );
    }

    const trackStock = params.trackStock ?? true;
    const tracksBatches = params.tracksBatches ?? false;

    // Trazar lotes de algo cuyas existencias no se llevan es una contradicción: el lote
    // sirve para saber qué queda y de dónde salió, y sin control de stock no hay ni lo uno
    // ni lo otro.
    if (tracksBatches && !trackStock) {
      throw new BusinessRuleViolationError(
        'BATCHES_REQUIRE_STOCK_TRACKING',
        'Para trazar lotes hay que llevar el control de existencias del producto',
      );
    }

    return new Product(params.id, {
      tenantId: params.tenantId,
      categoryId: params.categoryId ?? null,
      sku,
      barcode: params.barcode?.trim() || null,
      name,
      description: params.description?.trim() || null,
      brand: params.brand?.trim() || null,
      price: params.price,
      costPrice,
      taxRate: params.taxRate ?? Percentage.create(DEFAULT_TAX_RATE),
      unit: params.unit ?? 'UNIT',
      // Nace a cero siempre: las existencias solo se mueven por el ledger. Aceptar un stock
      // inicial aquí crearía unidades sin un movimiento que las explique, y el kardex
      // dejaría de cuadrar desde el primer día.
      stockOnHand: 0,
      reorderPoint: requireNonNegative(params.reorderPoint ?? 0, 'reorderPoint'),
      reorderQuantity: requireNonNegative(params.reorderQuantity ?? 0, 'reorderQuantity'),
      isRetail,
      isInternal,
      isActive: true,
      trackStock,
      tracksBatches,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: ProductProps): Product {
    return new Product(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get categoryId(): string | null {
    return this.props.categoryId;
  }
  get sku(): string {
    return this.props.sku;
  }
  get barcode(): string | null {
    return this.props.barcode;
  }
  get name(): string {
    return this.props.name;
  }
  get description(): string | null {
    return this.props.description;
  }
  get brand(): string | null {
    return this.props.brand;
  }
  get price(): Money {
    return this.props.price;
  }
  get costPrice(): Money {
    return this.props.costPrice;
  }
  get taxRate(): Percentage {
    return this.props.taxRate;
  }
  get unit(): ProductUnitValue {
    return this.props.unit;
  }
  get stockOnHand(): number {
    return this.props.stockOnHand;
  }
  get reorderPoint(): number {
    return this.props.reorderPoint;
  }
  get reorderQuantity(): number {
    return this.props.reorderQuantity;
  }
  get isRetail(): boolean {
    return this.props.isRetail;
  }
  get isInternal(): boolean {
    return this.props.isInternal;
  }
  get isActive(): boolean {
    return this.props.isActive;
  }
  get trackStock(): boolean {
    return this.props.trackStock;
  }
  get tracksBatches(): boolean {
    return this.props.tracksBatches;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * Semáforo de existencias.
   *
   * `LOW` incluye el punto de pedido: estar justo en el mínimo ya es motivo de reposición,
   * porque el mínimo es lo que se necesita para aguantar hasta que llegue el pedido, no un
   * umbral que se pueda rozar tranquilamente.
   *
   * Un producto sin control de existencias siempre está disponible: no tiene sentido
   * avisar de que falta algo cuya cantidad nadie lleva.
   */
  get stockStatus(): StockStatus {
    if (!this.props.trackStock) return 'AVAILABLE';
    if (this.props.stockOnHand <= QUANTITY_EPSILON) return 'OUT';
    if (this.props.stockOnHand <= this.props.reorderPoint) return 'LOW';
    return 'AVAILABLE';
  }

  /** Cuánto falta para llegar al mínimo. Cero si no hace falta reponer. */
  get missingToReorderPoint(): number {
    const missing = this.props.reorderPoint - this.props.stockOnHand;
    return missing > QUANTITY_EPSILON ? round3(missing) : 0;
  }

  /** Valor de las existencias al coste medio. Con lotes, el real lo da cada lote. */
  get stockValue(): Money {
    return this.props.costPrice.multiply(this.props.stockOnHand);
  }

  /** Margen sobre precio de venta. `null` si el producto es gratuito o solo interno. */
  marginPercentage(): number | null {
    if (this.props.price.isZero()) return null;
    const margin = this.props.price.minorUnits - this.props.costPrice.minorUnits;
    return round3((margin / this.props.price.minorUnits) * 100);
  }

  // -- Comportamiento -------------------------------------------------------

  /**
   * Aplica una variación de existencias y devuelve el saldo resultante.
   *
   * Recibe la **variación**, nunca el valor final. La diferencia es la que separa
   * `stock = leído + 5` de `stock = stock + 5`: la primera pierde la entrada de quien
   * escribiera entremedias, la segunda no. El repositorio traduce esto a un `UPDATE`
   * condicional, y el `CHECK` de la base cierra lo que quede.
   */
  applyDelta(delta: number, now: Date, actorId: string | null): number {
    if (!Number.isFinite(delta) || delta === 0) {
      throw new DomainValidationError('La variación de existencias no puede ser cero', 'delta');
    }

    if (!this.props.trackStock) {
      throw new BusinessRuleViolationError(
        'PRODUCT_DOES_NOT_TRACK_STOCK',
        `El producto ${this.props.sku} no lleva control de existencias`,
        { productId: this.id },
      );
    }

    const balance = round3(this.props.stockOnHand + delta);

    if (balance < -QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'INSUFFICIENT_STOCK',
        `Existencias insuficientes de ${this.props.name}: hay ${this.props.stockOnHand} y se piden ${Math.abs(delta)}`,
        { productId: this.id, available: this.props.stockOnHand, requested: Math.abs(delta) },
      );
    }

    this.props = {
      ...this.props,
      stockOnHand: Math.max(balance, 0),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };

    return this.props.stockOnHand;
  }

  /**
   * Recalcula el coste medio ponderado tras una entrada (ADR-0011).
   *
   * Se aplica **antes** de sumar la cantidad al stock, porque la media pondera con las
   * existencias que había, no con las que habrá. Invertir el orden diluiría el coste nuevo
   * consigo mismo y daría una media sistemáticamente baja.
   *
   * En productos con lote esta cifra queda como referencia de gestión: la valoración de
   * cada salida la da el lote del que sale, que es un coste real y no una media.
   */
  applyReceiptCost(quantity: number, unitCost: Money, now: Date, actorId: string | null): void {
    if (!(quantity > 0)) {
      throw new DomainValidationError('La cantidad recibida debe ser mayor que cero', 'quantity');
    }
    if (unitCost.isNegative()) {
      throw new DomainValidationError('El coste unitario no puede ser negativo', 'unitCost');
    }
    if (unitCost.currency !== this.props.costPrice.currency) {
      throw new DomainValidationError(
        `La entrada está en ${unitCost.currency} y el producto opera en ${this.props.costPrice.currency}`,
        'currency',
      );
    }

    const previousQuantity = this.props.stockOnHand;
    const totalQuantity = previousQuantity + quantity;

    // Sin existencias previas no hay nada que promediar y manda el coste nuevo. Ocurre en
    // la primera compra y tras un recuento que dejó el producto a cero.
    const costPrice =
      previousQuantity <= QUANTITY_EPSILON
        ? unitCost
        : Money.fromMinorUnits(
            Math.round(
              (this.props.costPrice.multiply(previousQuantity).minorUnits +
                unitCost.multiply(quantity).minorUnits) /
                totalQuantity,
            ),
            unitCost.currency,
          );

    this.props = {
      ...this.props,
      costPrice,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Fija el coste directamente. Solo para corregir un histórico, y queda auditado. */
  overrideCost(costPrice: Money, now: Date, actorId: string | null): void {
    if (costPrice.isNegative()) {
      throw new DomainValidationError('El coste no puede ser negativo', 'costPrice');
    }
    this.props = {
      ...this.props,
      costPrice,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  update(
    changes: {
      name?: string;
      description?: string | null;
      brand?: string | null;
      barcode?: string | null;
      categoryId?: string | null;
      price?: Money;
      taxRate?: Percentage;
      unit?: ProductUnitValue;
      reorderPoint?: number;
      reorderQuantity?: number;
      isRetail?: boolean;
      isInternal?: boolean;
      isActive?: boolean;
      trackStock?: boolean;
      tracksBatches?: boolean;
    },
    now: Date,
    actorId: string | null,
  ): void {
    if (changes.price?.isNegative()) {
      throw new DomainValidationError('El precio no puede ser negativo', 'price');
    }
    if (changes.price && changes.price.currency !== this.props.price.currency) {
      throw new DomainValidationError(
        `El producto opera en ${this.props.price.currency} y no se puede cambiar de moneda`,
        'currency',
      );
    }

    const isRetail = changes.isRetail ?? this.props.isRetail;
    const isInternal = changes.isInternal ?? this.props.isInternal;
    if (!isRetail && !isInternal) {
      throw new BusinessRuleViolationError(
        'PRODUCT_HAS_NO_USE',
        'Un producto debe venderse al público, usarse en cabina, o ambas cosas',
      );
    }

    const trackStock = changes.trackStock ?? this.props.trackStock;
    const tracksBatches = changes.tracksBatches ?? this.props.tracksBatches;
    if (tracksBatches && !trackStock) {
      throw new BusinessRuleViolationError(
        'BATCHES_REQUIRE_STOCK_TRACKING',
        'Para trazar lotes hay que llevar el control de existencias del producto',
      );
    }

    // Dejar de llevar existencias con producto en la estantería haría desaparecer del
    // sistema unas unidades que siguen existiendo. Primero se ajusta a cero, con su
    // movimiento en el kardex, y después se desactiva el seguimiento.
    if (!trackStock && this.props.trackStock && this.props.stockOnHand > QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'STOCK_TRACKING_CANNOT_BE_DISABLED',
        `No se puede dejar de controlar existencias de ${this.props.name}: quedan ${this.props.stockOnHand} unidades. Ajústelas a cero primero.`,
        { productId: this.id, stockOnHand: this.props.stockOnHand },
      );
    }

    this.props = {
      ...this.props,
      name:
        changes.name === undefined
          ? this.props.name
          : requireText(changes.name, 'name', 'El nombre del producto es obligatorio'),
      description:
        changes.description === undefined
          ? this.props.description
          : changes.description?.trim() || null,
      brand: changes.brand === undefined ? this.props.brand : changes.brand?.trim() || null,
      barcode: changes.barcode === undefined ? this.props.barcode : changes.barcode?.trim() || null,
      categoryId: changes.categoryId === undefined ? this.props.categoryId : changes.categoryId,
      price: changes.price ?? this.props.price,
      taxRate: changes.taxRate ?? this.props.taxRate,
      unit: changes.unit ?? this.props.unit,
      reorderPoint:
        changes.reorderPoint === undefined
          ? this.props.reorderPoint
          : requireNonNegative(changes.reorderPoint, 'reorderPoint'),
      reorderQuantity:
        changes.reorderQuantity === undefined
          ? this.props.reorderQuantity
          : requireNonNegative(changes.reorderQuantity, 'reorderQuantity'),
      isRetail,
      isInternal,
      isActive: changes.isActive ?? this.props.isActive,
      trackStock,
      tracksBatches,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  markDeleted(now: Date, actorId: string | null): void {
    // Dar de baja producto que aún está en la estantería lo haría desaparecer del
    // inventario sin que nadie lo haya consumido, y el valor del almacén bajaría sin
    // movimiento que lo explique.
    if (this.props.trackStock && this.props.stockOnHand > QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'PRODUCT_HAS_STOCK',
        `No se puede dar de baja ${this.props.name}: quedan ${this.props.stockOnHand} unidades en existencias`,
        { productId: this.id, stockOnHand: this.props.stockOnHand },
      );
    }

    this.props = {
      ...this.props,
      isActive: false,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      isActive: true,
      audit: {
        ...this.props.audit,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Normaliza el SKU a mayúsculas.
 *
 * Es la referencia con la que se busca en el almacén y se teclea en el punto de venta.
 * Sin normalizar, `sh-01` y `SH-01` conviven como dos productos distintos y el índice
 * único no lo impide, porque para PostgreSQL son cadenas diferentes.
 */
const normalizeSku = (value: string): string => {
  const sku = value?.trim().toUpperCase();

  if (!sku) {
    throw new DomainValidationError('El SKU es obligatorio', 'sku');
  }
  if (!SKU_PATTERN.test(sku)) {
    throw new DomainValidationError(
      'El SKU admite letras, dígitos, punto, guion y guion bajo, y debe empezar por letra o dígito',
      'sku',
    );
  }

  return sku;
};

const requireText = (value: string, field: string, message: string): string => {
  const text = value?.trim();
  if (!text) throw new DomainValidationError(message, field);
  return text;
};

const requireNonNegative = (value: number, field: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainValidationError('El valor no puede ser negativo', field);
  }
  return round3(value);
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
