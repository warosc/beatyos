import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  AuthenticationError,
  BusinessRuleViolationError,
  ConflictError,
  DomainError,
  DomainValidationError,
  EntityNotFoundError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from '../../../domain/errors';
import { RequestContextStore } from '../../context/request-context';
import { MissingTenantScopeError } from '../../persistence/prisma/prisma.extensions';

/**
 * Filtro global de errores (ADR-0008).
 *
 * Es el **único** punto del sistema que conoce a la vez el dominio y HTTP. Gracias a
 * eso, ninguna entidad ni caso de uso importa `@nestjs/common` para lanzar un 404, y el
 * dominio sigue siendo ejecutable desde un worker o un script sin arrastrar el
 * transporte.
 *
 * El formato de salida es RFC 9457 (Problem Details) con dos extensiones propias:
 * `code`, que es el contrato estable sobre el que ramifican los clientes, y
 * `correlationId`, que une la respuesta con los logs del servidor.
 */

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  correlationId: string;
  errors?: { field?: string; message: string }[];
}

const ERROR_BASE_URI = 'https://api.salon.app/errors';

/**
 * Traducción de error de dominio a estado HTTP. Es toda la frontera entre ambos mundos.
 *
 * Se guardan **predicados** y no clases: los errores de dominio tienen el constructor
 * `protected` —para forzar que se usen sus subclases— y TypeScript no admite un
 * constructor protegido donde espera un tipo constructor. Con predicados no hace falta
 * ninguna conversión que engañe al compilador, y el `instanceof` sigue haciendo que las
 * subclases hereden el estado de su padre sin registrarse una por una.
 *
 * **El orden importa**: se devuelve la primera coincidencia, así que las clases base van
 * antes que las hermanas más específicas que podrían capturarlas por error.
 */
const STATUS_BY_ERROR: ReadonlyArray<[(error: DomainError) => boolean, HttpStatus]> = [
  [(error) => error instanceof AuthenticationError, HttpStatus.UNAUTHORIZED],
  [(error) => error instanceof EntityNotFoundError, HttpStatus.NOT_FOUND],
  [(error) => error instanceof ConflictError, HttpStatus.CONFLICT],
  [(error) => error instanceof ForbiddenActionError, HttpStatus.FORBIDDEN],
  [(error) => error instanceof DomainValidationError, HttpStatus.BAD_REQUEST],
  // 422 y no 400: la petición está bien formada y el servidor la entiende; lo que falla
  // es una regla de negocio. La distinción le dice al cliente si reintentar con otros
  // datos tiene sentido o si el problema es el estado del sistema.
  [(error) => error instanceof InvalidStateTransitionError, HttpStatus.UNPROCESSABLE_ENTITY],
  [(error) => error instanceof BusinessRuleViolationError, HttpStatus.UNPROCESSABLE_ENTITY],
];

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = RequestContextStore.correlationId;

    const problem = this.toProblemDetails(exception, request, correlationId);

    // Los 5xx son fallos nuestros y se registran enteros, con traza. Los 4xx son
    // comportamiento esperado del cliente y solo dejan una línea: registrarlos con la
    // misma severidad ahogaría los fallos reales entre miles de 404 rutinarios.
    if (problem.status >= 500) {
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} -> ${problem.status} ${problem.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${correlationId}] ${request.method} ${request.url} -> ${problem.status} ${problem.code}`,
      );
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblemDetails(
    exception: unknown,
    request: Request,
    correlationId: string,
  ): ProblemDetails {
    const instance = request.url;

    if (exception instanceof DomainError) {
      const status = this.statusFor(exception);
      return {
        type: `${ERROR_BASE_URI}/${exception.code.toLowerCase().replace(/_/g, '-')}`,
        title: exception.message,
        status,
        code: exception.code,
        detail: exception.message,
        instance,
        correlationId,
        ...(exception instanceof DomainValidationError && exception.field
          ? { errors: [{ field: exception.field, message: exception.message }] }
          : {}),
      };
    }

    // Un fallo de ámbito de tenant no es culpa del usuario: es un endpoint mal
    // construido. Se responde 500 y se registra como el error de programación que es,
    // sin insinuar al cliente que puede arreglarlo cambiando la petición.
    if (exception instanceof MissingTenantScopeError) {
      this.logger.error(`[${correlationId}] Consulta sin ámbito de salón: ${exception.message}`);
      return this.internalError(instance, correlationId);
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, instance, correlationId);
    }

    return this.internalError(instance, correlationId, exception);
  }

  private statusFor(error: DomainError): HttpStatus {
    // Primera coincidencia gana. Cada predicado usa `instanceof`, de modo que las
    // subclases heredan el estado de su padre sin registrarse una por una.
    const match = STATUS_BY_ERROR.find(([matches]) => matches(error));
    if (match) return match[1];

    // Un error de dominio sin traducción es una omisión del equipo. Se responde 500 y se
    // grita en el log, en vez de adivinar un código y esconder el descuido (ADR-0008).
    this.logger.error(
      `El error de dominio ${error.constructor.name} (${error.code}) no tiene estado HTTP ` +
        'asignado. Añádalo a STATUS_BY_ERROR en domain-exception.filter.ts.',
    );
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private fromHttpException(
    exception: HttpException,
    instance: string,
    correlationId: string,
  ): ProblemDetails {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // `class-validator` entrega los fallos como array de cadenas. Se convierten en la
    // lista `errors` de Problem Details para que el cliente pueda marcar cada campo.
    let errors: { field?: string; message: string }[] | undefined;
    let title = exception.message;

    if (typeof payload === 'object' && payload !== null) {
      const body = payload as { message?: string | string[]; error?: string };
      if (Array.isArray(body.message)) {
        errors = body.message.map((message) => ({
          field: this.guessFieldFromMessage(message),
          message,
        }));
        title = 'La petición contiene datos no válidos';
      } else if (typeof body.message === 'string') {
        title = body.message;
      }
    }

    return {
      type: `${ERROR_BASE_URI}/${this.slugForStatus(status)}`,
      title,
      status,
      code: this.codeForStatus(status),
      detail: title,
      instance,
      correlationId,
      ...(errors ? { errors } : {}),
    };
  }

  private internalError(
    instance: string,
    correlationId: string,
    exception?: unknown,
  ): ProblemDetails {
    return {
      type: `${ERROR_BASE_URI}/internal-server-error`,
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      // El mensaje real solo sale fuera de producción. Un stack trace en la respuesta
      // regala versiones de librerías, rutas del sistema de ficheros y estructura
      // interna a quien esté sondeando la API.
      detail: this.isProduction
        ? `Se ha producido un error inesperado. Facilite este identificador a soporte: ${correlationId}`
        : exception instanceof Error
          ? exception.message
          : String(exception),
      instance,
      correlationId,
    };
  }

  /** `"email must be an email"` → `"email"`. Heurística; si falla, se omite el campo. */
  private guessFieldFromMessage(message: string): string | undefined {
    return /^([a-zA-Z][a-zA-Z0-9_.]*)\s/.exec(message)?.[1];
  }

  private slugForStatus(status: number): string {
    return (
      {
        400: 'bad-request',
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not-found',
        409: 'conflict',
        422: 'unprocessable-entity',
        429: 'too-many-requests',
      }[status] ?? 'error'
    );
  }

  private codeForStatus(status: number): string {
    return (
      {
        400: 'VALIDATION_ERROR',
        401: 'UNAUTHENTICATED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        422: 'UNPROCESSABLE_ENTITY',
        429: 'RATE_LIMIT_EXCEEDED',
      }[status] ?? 'INTERNAL_SERVER_ERROR'
    );
  }
}
