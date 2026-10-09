import { DomainValidationError } from '../../../shared/domain/errors';

/** Días de cada mes. Febrero admite el 29: hay quien cumple en año bisiesto. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * Cumpleaños de una clienta: día y mes, **sin año**.
 *
 * Al salón le basta con saber cuándo felicitarla; el año solo serviría para saber su edad,
 * que es un dato que nadie necesita para atenderla y que a muchas clientas les incomoda dar.
 * Lo que no se pide no se puede filtrar ni perder: por eso el modelo ni siquiera tiene
 * dónde guardarlo.
 */
export class Birthday {
  private constructor(
    readonly month: number,
    readonly day: number,
  ) {}

  static create(month: number, day: number): Birthday {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new DomainValidationError('El mes del cumpleaños debe estar entre 1 y 12', 'birthday');
    }
    if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
      throw new DomainValidationError(
        `${MONTHS[month - 1]} no tiene día ${day}`.replace(/^./, (c) => c.toUpperCase()),
        'birthday',
      );
    }
    return new Birthday(month, day);
  }

  /** Lee el formato `MM-DD` de la API, p. ej. `04-17`. */
  static parse(value: string): Birthday {
    const match = /^(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
      throw new DomainValidationError(
        'El cumpleaños se indica como MM-DD, p. ej. 04-17',
        'birthday',
      );
    }
    return Birthday.create(Number(match[1]), Number(match[2]));
  }

  static parseOptional(value: string | null | undefined): Birthday | null {
    return value ? Birthday.parse(value) : null;
  }

  /**
   * Próxima vez que cumple, contando hoy. Quien cumple el 29 de febrero lo celebra el 28
   * en los años que no son bisiestos, en lugar de saltar al 1 de marzo.
   */
  nextOccurrence(reference: Date): Date {
    const on = (year: number) => {
      const lastDay = new Date(year, this.month, 0).getDate();
      return new Date(year, this.month - 1, Math.min(this.day, lastDay));
    };
    const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    const thisYear = on(reference.getFullYear());
    return thisYear.getTime() < today.getTime() ? on(reference.getFullYear() + 1) : thisYear;
  }

  /** `MM-DD`, el formato de la API. */
  toString(): string {
    return `${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }

  /** «17 de abril». */
  toSpanish(): string {
    return `${this.day} de ${MONTHS[this.month - 1]}`;
  }
}
