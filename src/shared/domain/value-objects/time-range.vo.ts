import { DomainValidationError } from '../errors';
import { ValueObject } from '../primitives';

interface TimeRangeProps extends Record<string, unknown> {
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * Intervalo temporal **semiabierto** `[startsAt, endsAt)`.
 *
 * El carácter semiabierto no es un detalle: es la razón de que una cita de 10:00 a 11:00
 * y otra de 11:00 a 12:00 no se consideren solapadas. Con intervalos cerrados, el
 * sistema rechazaría reservas consecutivas —el caso más frecuente de una peluquería— y
 * el usuario lo viviría como un error del programa.
 *
 * Coincide exactamente con la semántica del `tstzrange(..., '[)')` de la restricción
 * EXCLUDE de la base de datos, de modo que dominio y motor no puedan discrepar.
 *
 * Internamente guarda epoch en milisegundos: comparar números evita la trampa de
 * comparar objetos `Date` por referencia.
 */
export class TimeRange extends ValueObject<TimeRangeProps> {
  private constructor(startsAt: number, endsAt: number) {
    super({ startsAt, endsAt });
  }

  public static create(startsAt: Date, endsAt: Date): TimeRange {
    const start = startsAt?.getTime();
    const end = endsAt?.getTime();

    if (!Number.isFinite(start)) {
      throw new DomainValidationError('La fecha de inicio no es válida', 'startsAt');
    }
    if (!Number.isFinite(end)) {
      throw new DomainValidationError('La fecha de fin no es válida', 'endsAt');
    }
    if (end <= start) {
      throw new DomainValidationError(
        'La fecha de fin debe ser posterior a la de inicio',
        'endsAt',
      );
    }

    return new TimeRange(start, end);
  }

  /** Construcción a partir de inicio y duración, que es como se agenda en la práctica. */
  public static fromDuration(startsAt: Date, durationMinutes: number): TimeRange {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new DomainValidationError(
        'La duración debe ser un número entero de minutos mayor que cero',
        'durationMinutes',
      );
    }
    return TimeRange.create(startsAt, new Date(startsAt.getTime() + durationMinutes * 60_000));
  }

  public get startsAt(): Date {
    return new Date(this.props.startsAt);
  }

  public get endsAt(): Date {
    return new Date(this.props.endsAt);
  }

  public get durationMinutes(): number {
    return Math.round((this.props.endsAt - this.props.startsAt) / 60_000);
  }

  /** Solapamiento con semántica semiabierta: tocarse por el extremo no es solaparse. */
  public overlaps(other: TimeRange): boolean {
    return this.props.startsAt < other.props.endsAt && other.props.startsAt < this.props.endsAt;
  }

  public contains(instant: Date): boolean {
    const time = instant.getTime();
    return time >= this.props.startsAt && time < this.props.endsAt;
  }

  /** `true` si este intervalo cabe entero dentro de `other`. */
  public isWithin(other: TimeRange): boolean {
    return this.props.startsAt >= other.props.startsAt && this.props.endsAt <= other.props.endsAt;
  }

  public isBefore(other: TimeRange): boolean {
    return this.props.endsAt <= other.props.startsAt;
  }

  public isInThePast(now: Date): boolean {
    return this.props.endsAt <= now.getTime();
  }

  /** Desplaza el intervalo conservando la duración: es lo que hace arrastrar una cita. */
  public shiftTo(newStart: Date): TimeRange {
    return TimeRange.fromDuration(newStart, this.durationMinutes);
  }

  /** Alarga o acorta por el final, manteniendo el inicio. */
  public withDuration(durationMinutes: number): TimeRange {
    return TimeRange.fromDuration(this.startsAt, durationMinutes);
  }

  /** Añade minutos al final: margen de limpieza que bloquea agenda pero no se factura. */
  public extendBy(minutes: number): TimeRange {
    if (minutes < 0) {
      throw new DomainValidationError('La extensión no puede ser negativa', 'minutes');
    }
    return TimeRange.create(this.startsAt, new Date(this.props.endsAt + minutes * 60_000));
  }

  public override toString(): string {
    return `[${this.startsAt.toISOString()}, ${this.endsAt.toISOString()})`;
  }

  public toJSON(): { startsAt: string; endsAt: string; durationMinutes: number } {
    return {
      startsAt: this.startsAt.toISOString(),
      endsAt: this.endsAt.toISOString(),
      durationMinutes: this.durationMinutes,
    };
  }
}

interface PercentageProps extends Record<string, unknown> {
  readonly value: number;
}

/**
 * Porcentaje entre 0 y 100, con dos decimales.
 *
 * Existe para zanjar la ambigüedad de siempre: ¿`0.21` o `21`? Aquí es siempre `21`,
 * y quien quiera el factor multiplicador usa `asFraction`.
 */
export class Percentage extends ValueObject<PercentageProps> {
  private constructor(value: number) {
    super({ value });
  }

  public static create(value: number): Percentage {
    if (!Number.isFinite(value)) {
      throw new DomainValidationError('El porcentaje debe ser un número finito', 'percentage');
    }
    if (value < 0 || value > 100) {
      throw new DomainValidationError(
        `El porcentaje debe estar entre 0 y 100, se recibió ${value}`,
        'percentage',
      );
    }
    return new Percentage(Math.round(value * 100) / 100);
  }

  public static zero(): Percentage {
    return new Percentage(0);
  }

  public get value(): number {
    return this.props.value;
  }

  /** `21` → `0.21`. Para multiplicar directamente. */
  public get asFraction(): number {
    return this.props.value / 100;
  }

  public isZero(): boolean {
    return this.props.value === 0;
  }

  public override toString(): string {
    return `${this.props.value}%`;
  }

  public toJSON(): number {
    return this.props.value;
  }
}
