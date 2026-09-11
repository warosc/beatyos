import { DomainValidationError } from '../../../shared/domain/errors';
import { ValueObject } from '../../../shared/domain/primitives';

/**
 * Cantidad de una línea de compra, en milésimas enteras.
 *
 * Es el mismo truco que `Money` con los céntimos, y por el mismo motivo. El esquema
 * declara `Decimal(12, 3)`, así que la cantidad **ya está** definida sobre una rejilla de
 * milésimas; representarla con `number` y restar en coma flotante la saca de esa rejilla:
 * `0,3 − 0,1` da `0,19999999999999998`, y comparar esa cifra con los `0,2` que alguien
 * intenta recibir rechazaba una recepción legítima con `INVALID_RECEIPT_QUANTITY`.
 *
 * La versión anterior lo corregía redondeando el resultado de la resta. Funcionaba, pero
 * dejaba la puerta abierta: cualquier operación nueva que olvidase el redondeo volvía a
 * introducir el fallo. Guardando el entero, la resta es exacta y no hay nada que recordar.
 *
 * `toNumber()` existe porque la frontera con inventario habla en `number`
 * (`ReceiveStockUseCase`). La conversión ocurre en un solo sitio y hacia fuera, nunca
 * entre dos operaciones del dominio.
 */

const SCALE = 1000;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

interface QuantityProps extends Record<string, unknown> {
  readonly thousandths: number;
}

export class Quantity extends ValueObject<QuantityProps> {
  private constructor(thousandths: number) {
    super({ thousandths });
  }

  /**
   * Desde una cadena decimal o un número.
   *
   * Rechaza más de tres decimales en lugar de redondearlos: aceptar `0,0005` y guardarlo
   * como `0,001` haría que la línea recibida no cuadrase con la pedida por un motivo que
   * nadie podría ver en la pantalla.
   */
  public static fromDecimal(value: string | number): Quantity {
    const text = typeof value === 'number' ? Quantity.numberToText(value) : value.trim();

    if (!DECIMAL_PATTERN.test(text)) {
      throw new DomainValidationError(`Cantidad no válida: "${text}"`, 'quantity');
    }

    const negative = text.startsWith('-');
    const [whole = '0', fraction = ''] = text.replace('-', '').split('.');

    if (fraction.replace(/0+$/, '').length > 3) {
      throw new DomainValidationError(
        `La cantidad admite tres decimales; "${text}" tiene más precisión de la representable`,
        'quantity',
      );
    }

    const padded = fraction.padEnd(3, '0').slice(0, 3);
    const thousandths = Number(`${whole}${padded}`);
    return new Quantity(negative ? -thousandths : thousandths);
  }

  public static zero(): Quantity {
    return new Quantity(0);
  }

  public get thousandths(): number {
    return this.props.thousandths;
  }

  public add(other: Quantity): Quantity {
    return new Quantity(this.thousandths + other.thousandths);
  }

  public subtract(other: Quantity): Quantity {
    return new Quantity(this.thousandths - other.thousandths);
  }

  public isPositive(): boolean {
    return this.thousandths > 0;
  }

  public isZero(): boolean {
    return this.thousandths === 0;
  }

  public isNegative(): boolean {
    return this.thousandths < 0;
  }

  public greaterThan(other: Quantity): boolean {
    return this.thousandths > other.thousandths;
  }

  public greaterThanOrEqual(other: Quantity): boolean {
    return this.thousandths >= other.thousandths;
  }

  /** Valor en unidades. Solo para cruzar hacia inventario o hacia la respuesta HTTP. */
  public toNumber(): number {
    return this.thousandths / SCALE;
  }

  /** Cadena con tres decimales, que es como la guarda el esquema. */
  public toDecimalString(): string {
    const negative = this.thousandths < 0;
    const absolute = Math.abs(this.thousandths);
    const whole = Math.trunc(absolute / SCALE);
    const fraction = String(absolute % SCALE).padStart(3, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  public override toString(): string {
    return this.toDecimalString();
  }

  /** Evita la notación exponencial que `Number.prototype.toString` produce en valores pequeños. */
  private static numberToText(value: number): string {
    if (!Number.isFinite(value)) {
      throw new DomainValidationError(`Cantidad no finita: ${value}`, 'quantity');
    }
    return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }
}
