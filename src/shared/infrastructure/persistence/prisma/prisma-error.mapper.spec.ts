import { Prisma } from '@prisma/client';

import {
  BusinessRuleViolationError,
  ConflictError,
  EntityNotFoundError,
} from '../../../domain/errors';
import { mapPrismaError, withMappedErrors } from './prisma-error.mapper';

/**
 * Traducción de errores de persistencia (ADR-0008).
 *
 * Estos tests protegen dos cosas a la vez:
 *
 * - Que las **restricciones de la base de datos** —que son reglas de negocio hechas
 *   cumplir por PostgreSQL— lleguen al usuario como un mensaje que entiende, y no como
 *   un `23P01`.
 * - Que **no se filtre el esquema**: nombres de tabla, de columna o de índice no deben
 *   salir en la respuesta de quien está sondeando la API.
 */
describe('mapPrismaError', () => {
  const knownError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('mensaje interno de prisma', {
      code,
      clientVersion: '6.0.0',
      meta,
    });

  describe('restricciones de la base de datos', () => {
    it('traduce el solapamiento de citas a un mensaje del negocio', () => {
      const error = mapPrismaError(
        new Error(
          'conflicting key value violates exclusion constraint "appointments_no_overlap_per_stylist"',
        ),
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('APPOINTMENT_OVERLAP');
      // El usuario lee "ya tiene otra cita", no el nombre de la restricción.
      expect(error.message).toMatch(/otra cita en esa franja/);
    });

    it('traduce el stock negativo a existencias insuficientes', () => {
      const error = mapPrismaError(
        new Error('violates check constraint "products_stock_not_negative"'),
      );

      // Un CHECK es una regla de negocio incumplida (422), no un conflicto de estado (409).
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as BusinessRuleViolationError).code).toBe('INSUFFICIENT_STOCK');
    });

    it('traduce la caja ya abierta', () => {
      const error = mapPrismaError(
        new Error(
          'duplicate key value violates unique constraint "cash_sessions_one_open_per_tenant_uq"',
        ),
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('CASH_SESSION_ALREADY_OPEN');
    });

    it('distingue conflicto de regla incumplida por el tipo de restricción', () => {
      const unique = mapPrismaError(
        new Error('violates unique constraint "clients_tenant_email_uq"'),
      );
      const check = mapPrismaError(
        new Error('violates check constraint "invoice_lines_reference_matches_kind"'),
      );

      expect(unique).toBeInstanceOf(ConflictError);
      expect(check).toBeInstanceOf(BusinessRuleViolationError);
    });
  });

  describe('códigos de Prisma', () => {
    it('P2002 se convierte en conflicto y nombra los campos, no el índice', () => {
      const error = mapPrismaError(
        knownError('P2002', { target: ['tenantId', 'email', 'deletedAt'] }),
      );

      expect(error).toBeInstanceOf(ConflictError);
      // El cliente necesita saber qué campo marcar en rojo. `tenantId` y `deletedAt` se
      // omiten: son detalles internos que no significan nada para quien rellena el
      // formulario.
      expect((error as ConflictError).details).toEqual({ fields: ['email'] });
    });

    it('P2025 se convierte en "no encontrado"', () => {
      const error = mapPrismaError(knownError('P2025'), 'Clienta');

      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(error.message).toContain('Clienta');
    });

    it('P2003 señala una referencia inexistente', () => {
      const error = mapPrismaError(knownError('P2003'));
      expect((error as BusinessRuleViolationError).code).toBe('REFERENCED_ENTITY_MISSING');
    });

    it('P2014 señala que el registro está en uso', () => {
      const error = mapPrismaError(knownError('P2014'));
      expect((error as BusinessRuleViolationError).code).toBe('ENTITY_IN_USE');
    });

    it('un código desconocido se deja pasar sin inventarse una traducción', () => {
      const original = knownError('P9999');
      expect(mapPrismaError(original)).toBe(original);
    });

    it('nunca propaga el mensaje interno de Prisma en un error traducido', () => {
      const error = mapPrismaError(knownError('P2002', { target: ['email'] }));
      expect(error.message).not.toContain('mensaje interno de prisma');
    });
  });

  describe('otros errores', () => {
    it('un error de dominio pasa intacto', () => {
      // Un caso de uso puede lanzar `EntityNotFoundError` dentro de una transacción y no
      // se debe reenvolver.
      const domainError = new EntityNotFoundError('Cita', 'abc');
      expect(mapPrismaError(domainError)).toBe(domainError);
    });

    it('un valor que no es Error se envuelve en uno', () => {
      const error = mapPrismaError('algo fue mal');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('algo fue mal');
    });

    it('un Error corriente se devuelve tal cual', () => {
      const original = new Error('fallo de red');
      expect(mapPrismaError(original)).toBe(original);
    });
  });
});

describe('withMappedErrors', () => {
  it('devuelve el resultado cuando no hay fallo', async () => {
    await expect(withMappedErrors('Clienta', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('traduce el fallo con el nombre de entidad indicado', async () => {
    const failing = () =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: '6.0.0' }),
      );

    await expect(withMappedErrors('Profesional', failing)).rejects.toThrow(EntityNotFoundError);
    await expect(withMappedErrors('Profesional', failing)).rejects.toThrow(/Profesional/);
  });
});
