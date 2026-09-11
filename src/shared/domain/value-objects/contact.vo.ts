import { DomainValidationError } from '../errors';
import { ValueObject } from '../primitives';

/**
 * Primitivas de contacto.
 *
 * Existen como value objects, y no como `string`, por dos motivos concretos:
 * la normalización ocurre en un único sitio (y no en cada caso de uso que toca un
 * correo), y el tipo hace imposible pasar un teléfono donde se espera un email.
 */

interface EmailProps extends Record<string, unknown> {
  readonly value: string;
}

/**
 * Dirección de correo.
 *
 * La validación es deliberadamente permisiva. La gramática real de RFC 5322 admite
 * cosas que ningún proveedor acepta, y las expresiones regulares "completas" que
 * circulan rechazan direcciones legítimas (`.museum`, subdominios largos, `+` de
 * etiquetado). La única prueba de que un correo existe es enviarle un mensaje; aquí
 * solo se descartan errores de tecleo evidentes.
 */
export class Email extends ValueObject<EmailProps> {
  private static readonly PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
  private static readonly MAX_LENGTH = 254; // RFC 5321: longitud máxima del camino de retorno

  private constructor(value: string) {
    super({ value });
  }

  public static create(raw: string): Email {
    const value = raw?.trim().toLowerCase();

    if (!value) {
      throw new DomainValidationError('El correo electrónico es obligatorio', 'email');
    }
    if (value.length > Email.MAX_LENGTH) {
      throw new DomainValidationError(
        `El correo no puede superar ${Email.MAX_LENGTH} caracteres`,
        'email',
      );
    }
    if (!Email.PATTERN.test(value)) {
      throw new DomainValidationError(`Correo electrónico no válido: "${raw}"`, 'email');
    }

    return new Email(value);
  }

  /** Para campos opcionales: una cadena vacía es "sin correo", no un correo inválido. */
  public static createOptional(raw: string | null | undefined): Email | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    return Email.create(raw);
  }

  public get value(): string {
    return this.props.value;
  }

  public get domain(): string {
    return this.props.value.slice(this.props.value.indexOf('@') + 1);
  }

  /**
   * Versión enmascarada para logs y auditoría: `an***@gmail.com`.
   * Un correo es dato personal y no debe aparecer entero en un log de aplicación.
   */
  public masked(): string {
    const [local = '', domain = ''] = this.props.value.split('@');
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
  }

  public override toString(): string {
    return this.props.value;
  }

  public toJSON(): string {
    return this.props.value;
  }
}

interface PhoneProps extends Record<string, unknown> {
  readonly value: string;
}

/**
 * Teléfono en formato E.164 relajado.
 *
 * No se valida contra el plan de numeración de cada país: eso exige una base de datos
 * que caduca (libphonenumber) y añade una dependencia pesada para un beneficio que en
 * un salón es marginal. Se normaliza (se quitan espacios, guiones y paréntesis) y se
 * comprueba longitud y forma. Si el número es incorrecto, lo descubre la recepcionista
 * al llamar, no un validador.
 */
export class Phone extends ValueObject<PhoneProps> {
  private static readonly PATTERN = /^\+?[1-9]\d{6,14}$/;

  private constructor(value: string) {
    super({ value });
  }

  public static create(raw: string): Phone {
    const value = raw?.replace(/[\s\-().]/g, '');

    if (!value) {
      throw new DomainValidationError('El teléfono es obligatorio', 'phone');
    }
    if (!Phone.PATTERN.test(value)) {
      throw new DomainValidationError(
        `Teléfono no válido: "${raw}". Se esperan de 7 a 15 dígitos, opcionalmente con prefijo +`,
        'phone',
      );
    }

    return new Phone(value);
  }

  public static createOptional(raw: string | null | undefined): Phone | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    return Phone.create(raw);
  }

  public get value(): string {
    return this.props.value;
  }

  public masked(): string {
    const v = this.props.value;
    return `${'*'.repeat(Math.max(v.length - 3, 0))}${v.slice(-3)}`;
  }

  public override toString(): string {
    return this.props.value;
  }

  public toJSON(): string {
    return this.props.value;
  }
}

interface PersonNameProps extends Record<string, unknown> {
  readonly firstName: string;
  readonly lastName: string;
}

/** Nombre de una persona. Agrupa dos campos que siempre viajan juntos y se validan igual. */
export class PersonName extends ValueObject<PersonNameProps> {
  private static readonly MAX_LENGTH = 100;

  private constructor(firstName: string, lastName: string) {
    super({ firstName, lastName });
  }

  public static create(firstName: string, lastName: string): PersonName {
    const first = firstName?.trim();
    const last = lastName?.trim();

    if (!first) throw new DomainValidationError('El nombre es obligatorio', 'firstName');
    if (!last) throw new DomainValidationError('Los apellidos son obligatorios', 'lastName');
    if (first.length > PersonName.MAX_LENGTH) {
      throw new DomainValidationError(
        `El nombre no puede superar ${PersonName.MAX_LENGTH} caracteres`,
        'firstName',
      );
    }
    if (last.length > PersonName.MAX_LENGTH) {
      throw new DomainValidationError(
        `Los apellidos no pueden superar ${PersonName.MAX_LENGTH} caracteres`,
        'lastName',
      );
    }

    return new PersonName(first, last);
  }

  public get firstName(): string {
    return this.props.firstName;
  }

  public get lastName(): string {
    return this.props.lastName;
  }

  public get full(): string {
    return `${this.props.firstName} ${this.props.lastName}`;
  }

  public get initials(): string {
    return `${this.props.firstName.charAt(0)}${this.props.lastName.charAt(0)}`.toUpperCase();
  }

  public override toString(): string {
    return this.full;
  }
}
