import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

import {
  BusinessRuleViolationError,
  ConflictError,
  DomainError,
  DomainValidationError,
  EntityNotFoundError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from '../../../domain/errors';
import { InvalidCredentialsError } from '../../../../core/users/domain/user.errors';
import { RequestContextStore } from '../../context/request-context';
import { MissingTenantScopeError } from '../../persistence/prisma/prisma.extensions';
import { GlobalExceptionFilter } from './domain-exception.filter';

/**
 * Traducción de errores a HTTP (ADR-0008).
 *
 * Es la única frontera del sistema que conoce a la vez el dominio y HTTP, así que
 * concentra decisiones con consecuencias visibles: qué código recibe el cliente, qué se
 * le cuenta y —sobre todo— qué **no** se le cuenta.
 */
describe('GlobalExceptionFilter', () => {
  interface CapturedResponse {
    status: number;
    contentType: string;
    body: Record<string, unknown>;
  }

  const captureFor = (
    exception: unknown,
    options: { isProduction?: boolean; url?: string; method?: string } = {},
  ): CapturedResponse => {
    const captured: CapturedResponse = { status: 0, contentType: '', body: {} };

    const response = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      type(value: string) {
        captured.contentType = value;
        return this;
      },
      json(payload: Record<string, unknown>) {
        captured.body = payload;
        return this;
      },
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          url: options.url ?? '/api/v1/clients',
          method: options.method ?? 'GET',
        }),
      }),
    } as unknown as ArgumentsHost;

    new GlobalExceptionFilter(options.isProduction ?? false).catch(exception, host);
    return captured;
  };

  describe('errores de dominio', () => {
    it.each([
      [new EntityNotFoundError('Clienta', 'x'), HttpStatus.NOT_FOUND, 'ENTITY_NOT_FOUND'],
      [new ConflictError('DUP', 'duplicado'), HttpStatus.CONFLICT, 'DUP'],
      [new ForbiddenActionError('borrar'), HttpStatus.FORBIDDEN, 'FORBIDDEN_ACTION'],
      [new DomainValidationError('mal'), HttpStatus.BAD_REQUEST, 'DOMAIN_VALIDATION_ERROR'],
      [
        new BusinessRuleViolationError('RULE', 'no se puede'),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RULE',
      ],
      [
        new InvalidStateTransitionError('Factura', 'PAID', 'DRAFT'),
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_STATE_TRANSITION',
      ],
      [new InvalidCredentialsError(), HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS'],
    ])('traduce %p al estado correcto', (error, expectedStatus, expectedCode) => {
      const response = captureFor(error);

      expect(response.status).toBe(expectedStatus);
      expect(response.body.code).toBe(expectedCode);
    });

    it('las subclases heredan el estado de su padre sin registrarse una a una', () => {
      class ClientBlockedError extends BusinessRuleViolationError {
        constructor() {
          super('CLIENT_BLOCKED', 'La clienta está bloqueada');
        }
      }

      expect(captureFor(new ClientBlockedError()).status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('responde en formato Problem Details', () => {
      const response = captureFor(new EntityNotFoundError('Clienta', 'abc'));

      expect(response.contentType).toBe('application/problem+json');
      expect(response.body).toMatchObject({
        type: 'https://api.salon.app/errors/entity-not-found',
        status: 404,
        code: 'ENTITY_NOT_FOUND',
        instance: '/api/v1/clients',
      });
      expect(response.body.correlationId).toBeDefined();
    });

    it('un error de validación de dominio señala el campo', () => {
      const response = captureFor(new DomainValidationError('Correo no válido', 'email'));

      expect(response.body.errors).toEqual([{ field: 'email', message: 'Correo no válido' }]);
    });

    it('sin campo señalado no incluye la lista de errores', () => {
      expect(captureFor(new DomainValidationError('mal')).body.errors).toBeUndefined();
    });

    it('un error de dominio sin traducción responde 500 en vez de adivinar', () => {
      // Adivinar un código escondería la omisión del equipo; un 500 con su aviso en el
      // log la hace visible (ADR-0008).
      class UnmappedError extends DomainError {
        public readonly code = 'UNMAPPED';
        constructor() {
          super('sin traducción');
        }
      }

      expect(captureFor(new UnmappedError()).status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  describe('errores de framework', () => {
    it('convierte los fallos de class-validator en una lista de campos', () => {
      const exception = new BadRequestException({
        message: ['email must be an email', 'password should not be empty'],
        error: 'Bad Request',
      });

      const response = captureFor(exception);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      // El cliente necesita saber qué campo marcar en rojo, no una cadena suelta.
      expect(response.body.errors).toEqual([
        { field: 'email', message: 'email must be an email' },
        { field: 'password', message: 'password should not be empty' },
      ]);
    });

    it('respeta un mensaje único de HttpException', () => {
      const response = captureFor(new HttpException('No autorizado', HttpStatus.UNAUTHORIZED));

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(response.body.title).toBe('No autorizado');
    });

    it('mapea los estados conocidos a códigos estables', () => {
      expect(captureFor(new HttpException('x', 403)).body.code).toBe('FORBIDDEN');
      expect(captureFor(new HttpException('x', 404)).body.code).toBe('NOT_FOUND');
      expect(captureFor(new HttpException('x', 409)).body.code).toBe('CONFLICT');
      expect(captureFor(new HttpException('x', 429)).body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(captureFor(new HttpException('x', 418)).body.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('un objeto de respuesta sin mensaje reconocible no rompe el filtro', () => {
      const response = captureFor(new HttpException({ algo: 'raro' }, 400));
      expect(response.status).toBe(400);
    });
  });

  describe('fallos internos', () => {
    it('un fallo de ámbito de salón se trata como error del servidor', () => {
      // No es culpa del usuario: es un endpoint mal construido. Insinuarle que puede
      // arreglarlo cambiando la petición sería engañarlo.
      const response = captureFor(new MissingTenantScopeError('Client', 'findMany'));

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('findMany');
    });

    it('fuera de producción muestra el mensaje real, para poder depurar', () => {
      const response = captureFor(new Error('la conexión con Redis ha fallado'), {
        isProduction: false,
      });

      expect(response.body.detail).toBe('la conexión con Redis ha fallado');
    });

    it('en producción oculta el detalle y ofrece el identificador de correlación', () => {
      // Un mensaje interno regala versiones de librerías, rutas del sistema de ficheros y
      // estructura interna a quien esté sondeando la API.
      const response = captureFor(new Error('ECONNREFUSED 10.0.3.14:6379 en /srv/app/lib'), {
        isProduction: true,
      });

      expect(response.body.detail).not.toContain('10.0.3.14');
      expect(response.body.detail).toContain(String(response.body.correlationId));
    });

    it('un valor lanzado que no es Error tampoco rompe el filtro', () => {
      expect(captureFor('algo fue mal').status).toBe(500);
    });
  });

  describe('correlación', () => {
    it('reutiliza el identificador del contexto de la petición', () => {
      RequestContextStore.run({ correlationId: 'traza-123' }, () => {
        // Es lo que une la respuesta que ve el usuario con la línea del log del servidor.
        expect(captureFor(new EntityNotFoundError('Clienta', 'x')).body.correlationId).toBe(
          'traza-123',
        );
      });
    });
  });
});
