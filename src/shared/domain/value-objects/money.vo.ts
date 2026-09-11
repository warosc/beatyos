import { DomainValidationError } from '../errors';
import { ValueObject } from '../primitives';

/**
 * Importe monetario (ADR-0010).
 *
 * Se guarda como **entero de la unidad menor** (céntimos) más la moneda. Nunca `float`:
 * `0.1 + 0.2 !== 0.3` en IEEE-754, y en un arqueo de caja esa diferencia la ve el usuario.
 *
 * Inmutable: toda operación devuelve una instancia nueva.
 */

/**
 * Exponente decimal por moneda. La mayoría usa 2; el yen y el peso chileno, ninguno.
 *
 * `GTQ` figura explícitamente aunque su exponente coincida con el valor por defecto: es la
 * moneda de operación del producto y dejarla implícita haría que un error de tecleo en el
 * código —`GTC`, `QTZ`— pasara silenciosamente con dos decimales en lugar de saltar aquí.
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  GTQ: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  MXN: 2,
  COP: 2,
  ARS: 2,
  CLP: 0,
  JPY: 0,
};

const DEFAULT_EXPONENT = 2;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

interface MoneyProps extends Record<string, unknown> {
  readonly minorUnits: number;
  readonly currency: string;
}

export class Money extends ValueObject<MoneyProps> {
  private constructor(minorUnits: number, currency: string) {
    super({ minorUnits, currency });
  }

  // -- Construcción --------------------------------------------------------

  /** Desde la unidad menor ya calculada (1250 céntimos = 12,50 €). */
  public static fromMinorUnits(minorUnits: number, currency: string): Money {
    const normalized = Money.normalizeCurrency(currency);
    if (!Number.isInteger(minorUnits)) {
      throw new DomainValidationError(
        `Un importe en unidades menores debe ser entero, se recibió ${minorUnits}`,
        'amount',
      );
    }
    if (!Number.isSafeInteger(minorUnits)) {
      throw new DomainValidationError('Importe fuera del rango representable', 'amount');
    }
    return new Money(minorUnits, normalized);
  }

  /**
   * Desde una cadena decimal (`"12.50"`).
   *
   * Acepta `string` por diseño: es el formato en el que el importe cruza la frontera
   * JSON y el que devuelve el `numeric` de PostgreSQL. Se admite `number` como comodidad
   * para tests y literales, pero cualquier valor con más decimales de los que la moneda
   * admite se rechaza en lugar de redondearse en silencio: un redondeo implícito aquí es
   * exactamente el tipo de fallo que este value object existe para impedir.
   */
  public static fromDecimal(value: string | number, currency: string): Money {
    const normalized = Money.normalizeCurrency(currency);
    const text = typeof value === 'number' ? Money.numberToDecimalString(value) : value.trim();

    if (!DECIMAL_PATTERN.test(text)) {
      throw new DomainValidationError(`Importe decimal no válido: "${text}"`, 'amount');
    }

    const exponent = Money.exponentFor(normalized);
    const negative = text.startsWith('-');
    const [wholePart = '0', fractionPart = ''] = text.replace('-', '').split('.');

    if (fractionPart.length > exponent) {
      const significant = fractionPart.slice(exponent).replace(/0+$/, '');
      if (significant.length > 0) {
        throw new DomainValidationError(
          `${normalized} admite ${exponent} decimales; "${text}" tiene más precisión de la representable`,
          'amount',
        );
      }
    }

    const paddedFraction = fractionPart.padEnd(exponent, '0').slice(0, exponent);
    const minor = Number(`${wholePart}${paddedFraction}`);
    return Money.fromMinorUnits(negative ? -minor : minor, normalized);
  }

  public static zero(currency: string): Money {
    return new Money(0, Money.normalizeCurrency(currency));
  }

  // -- Acceso --------------------------------------------------------------

  public get minorUnits(): number {
    return this.props.minorUnits;
  }

  public get currency(): string {
    return this.props.currency;
  }

  public get exponent(): number {
    return Money.exponentFor(this.props.currency);
  }

  // -- Aritmética ----------------------------------------------------------

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  /**
   * Multiplica por una cantidad (que puede ser fraccionaria: 2,5 litros de producto).
   * El redondeo es half-up y explícito, y solo ocurre aquí.
   */
  public multiply(factor: number): Money {
    if (!Number.isFinite(factor)) {
      throw new DomainValidationError('El factor de multiplicación debe ser finito', 'factor');
    }
    return Money.fromMinorUnits(Money.roundHalfUp(this.minorUnits * factor), this.currency);
  }

  /** Aplica un porcentaje (21 → 21%). Útil para impuestos y comisiones. */
  public percentage(percent: number): Money {
    if (!Number.isFinite(percent)) {
      throw new DomainValidationError('El porcentaje debe ser finito', 'percent');
    }
    return Money.fromMinorUnits(
      Money.roundHalfUp((this.minorUnits * percent) / 100),
      this.currency,
    );
  }

  public negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  public absolute(): Money {
    return Money.fromMinorUnits(Math.abs(this.minorUnits), this.currency);
  }

  /**
   * Reparte el importe en partes proporcionales **sin perder ni inventar un céntimo**.
   *
   * Repartir 100,00 € entre tres líneas da 33,33 + 33,33 + 33,33 = 99,99: falta un
   * céntimo. Este método lo asigna de forma determinista a las partes con mayor resto
   * fraccionario (y, a igualdad de resto, a la primera), de modo que la suma de las
   * partes siempre cuadre con el total. Es la diferencia entre una factura que suma y
   * una que el cliente rechaza.
   */
  public allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new DomainValidationError('Se requiere al menos una parte para repartir', 'weights');
    }
    if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
      throw new DomainValidationError(
        'Los pesos de reparto deben ser finitos y no negativos',
        'weights',
      );
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      throw new DomainValidationError(
        'La suma de los pesos de reparto no puede ser cero',
        'weights',
      );
    }

    const exact = weights.map((w) => (this.minorUnits * w) / totalWeight);
    const floored = exact.map((v) => Math.floor(v));
    let remainder = this.minorUnits - floored.reduce((sum, v) => sum + v, 0);

    // Orden de reparto del resto: mayor parte fraccionaria primero; el índice desempata
    // para que el resultado sea reproducible ante pesos idénticos.
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

    const result = [...floored];
    for (const { index } of order) {
      if (remainder === 0) break;
      const step = remainder > 0 ? 1 : -1;
      result[index] += step;
      remainder -= step;
    }

    return result.map((minor) => Money.fromMinorUnits(minor, this.currency));
  }

  // -- Comparación ---------------------------------------------------------

  public isZero(): boolean {
    return this.minorUnits === 0;
  }

  public isPositive(): boolean {
    return this.minorUnits > 0;
  }

  public isNegative(): boolean {
    return this.minorUnits < 0;
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  public greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits >= other.minorUnits;
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  public static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  // -- Serialización -------------------------------------------------------

  /** Cadena decimal (`"12.50"`). Es como cruza la frontera JSON (ADR-0010). */
  public toDecimalString(): string {
    const exponent = this.exponent;
    const sign = this.minorUnits < 0 ? '-' : '';
    const absolute = Math.abs(this.minorUnits)
      .toString()
      .padStart(exponent + 1, '0');
    if (exponent === 0) return `${sign}${absolute}`;
    const whole = absolute.slice(0, -exponent);
    const fraction = absolute.slice(-exponent);
    return `${sign}${whole}.${fraction}`;
  }

  public toJSON(): { amount: string; currency: string } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  public override toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  /** Formato para el usuario final, según su locale. Solo para presentación. */
  public format(locale = 'es-GT'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: this.exponent,
    }).format(this.minorUnits / 10 ** this.exponent);
  }

  // -- Interno -------------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      // Convertir implícitamente sería peor que fallar: aplicaría un tipo de cambio
      // que nadie ha elegido y en un momento que nadie ha decidido.
      throw new DomainValidationError(
        `No se pueden operar importes en monedas distintas: ${this.currency} y ${other.currency}`,
        'currency',
      );
    }
  }

  private static normalizeCurrency(currency: string): string {
    const normalized = currency?.trim().toUpperCase();
    if (!normalized || !CURRENCY_PATTERN.test(normalized)) {
      throw new DomainValidationError(
        `Código de moneda ISO-4217 no válido: "${currency}"`,
        'currency',
      );
    }
    return normalized;
  }

  private static exponentFor(currency: string): number {
    return CURRENCY_EXPONENT[currency] ?? DEFAULT_EXPONENT;
  }

  /**
   * Half-up simétrico: 2,5 → 3 y −2,5 → −3.
   *
   * `Math.round` rompe la simetría (−2,5 → −2), lo que hace que un abono no sea el
   * exacto negativo del cargo que compensa.
   */
  private static roundHalfUp(value: number): number {
    return value < 0 ? -Math.round(-value) : Math.round(value);
  }

  /** Evita la notación exponencial de `Number.prototype.toString` en valores pequeños. */
  private static numberToDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
      throw new DomainValidationError(`Importe no finito: ${value}`, 'amount');
    }
    return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }
}
