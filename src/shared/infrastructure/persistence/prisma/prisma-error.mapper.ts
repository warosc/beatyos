import { Prisma } from '@prisma/client';

import {
  BusinessRuleViolationError,
  ConflictError,
  DomainError,
  EntityNotFoundError,
} from '../../../domain/errors';

/**
 * Traduce errores de PostgreSQL y Prisma a errores de dominio (ADR-0008).
 *
 * Dos razones para que esto exista:
 *
 * 1. **No filtrar el esquema.** Un mensaje como
 *    `Unique constraint failed on the fields: (tenantId, email)` revela nombres de
 *    tabla y de columna a quien esté probando el borde de la API.
 *
 * 2. **Las restricciones de la base son reglas de negocio.** Que dos citas no puedan
 *    solaparse es una regla que el usuario entiende. Cuando la hace cumplir un `EXCLUDE`,
 *    llega aquí como un error de PostgreSQL, y el usuario merece leer "esa franja ya
 *    está ocupada" y no "23P01".
 *
 * El mapa de nombres de restricción a mensajes es la contrapartida de haber puesto las
 * invariantes en la base de datos: hay que mantenerlo al día con la migración. A cambio,
 * las invariantes se cumplen incluso bajo concurrencia, que es algo que la aplicación
 * sola no puede prometer.
 */

interface ConstraintTranslation {
  readonly code: string;
  readonly message: string;
}

const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, ConstraintTranslation>> = {
  appointments_no_overlap_per_stylist: {
    code: 'APPOINTMENT_OVERLAP',
    message: 'El profesional ya tiene otra cita en esa franja horaria',
  },
  appointments_period_valid: {
    code: 'APPOINTMENT_INVALID_PERIOD',
    message: 'La hora de fin debe ser posterior a la de inicio',
  },
  products_stock_not_negative: {
    code: 'INSUFFICIENT_STOCK',
    message: 'No hay existencias suficientes para completar la operación',
  },
  cash_sessions_one_open_per_tenant_uq: {
    code: 'CASH_SESSION_ALREADY_OPEN',
    message: 'Ya hay una sesión de caja abierta; ciérrela antes de abrir otra',
  },
  users_tenant_email_uq: {
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'Ya existe un usuario con ese correo electrónico',
  },
  clients_tenant_email_uq: {
    code: 'CLIENT_EMAIL_ALREADY_EXISTS',
    message: 'Ya existe un cliente con ese correo electrónico',
  },
  stylists_tenant_email_uq: {
    code: 'STYLIST_EMAIL_ALREADY_EXISTS',
    message: 'Ya existe un profesional con ese correo electrónico',
  },
  services_tenant_code_uq: {
    code: 'SERVICE_CODE_ALREADY_EXISTS',
    message: 'Ya existe un servicio con ese código',
  },
  products_tenant_sku_uq: {
    code: 'PRODUCT_SKU_ALREADY_EXISTS',
    message: 'Ya existe un producto con esa referencia',
  },
  products_tenant_barcode_uq: {
    code: 'PRODUCT_BARCODE_ALREADY_EXISTS',
    message: 'Ya existe un producto con ese código de barras',
  },
  suppliers_tenant_code_uq: {
    code: 'SUPPLIER_CODE_ALREADY_EXISTS',
    message: 'Ya existe un proveedor con ese código',
  },
  categories_tenant_kind_slug_uq: {
    code: 'CATEGORY_SLUG_ALREADY_EXISTS',
    message: 'Ya existe una categoría con ese identificador',
  },
  invoices_tenant_number_uq: {
    code: 'INVOICE_NUMBER_ALREADY_EXISTS',
    message: 'Ya existe una factura con ese número',
  },
  roles_tenant_code_uq: {
    code: 'ROLE_CODE_ALREADY_EXISTS',
    message: 'Ya existe un rol con ese código',
  },
  invoice_lines_reference_matches_kind: {
    code: 'INVOICE_LINE_INVALID_REFERENCE',
    message: 'La línea de factura no referencia el tipo de elemento que declara',
  },
};

const findConstraintName = (haystack: string): string | undefined =>
  Object.keys(CONSTRAINT_TRANSLATIONS).find((name) => haystack.includes(name));

/**
 * Convierte cualquier error de persistencia en un error de dominio.
 *
 * Los errores que ya son de dominio pasan intactos: un caso de uso puede lanzar
 * `EntityNotFoundError` dentro de una transacción y no queremos reenvolverlo.
 */
export function mapPrismaError(error: unknown, entityHint = 'Recurso'): Error {
  if (error instanceof DomainError) {
    return error;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const constraint = findConstraintName(rawMessage);
  if (constraint) {
    const translation = CONSTRAINT_TRANSLATIONS[constraint];
    // Un EXCLUDE o una unicidad son conflictos de estado; un CHECK es una regla de
    // negocio incumplida. La distinción importa porque produce 409 frente a 422.
    const isConflict = rawMessage.includes('exclusion') || constraint.endsWith('_uq');
    return isConflict
      ? new ConflictError(translation.code, translation.message, { constraint })
      : new BusinessRuleViolationError(translation.code, translation.message, { constraint });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        const fields = (error.meta?.target as string[] | undefined) ?? [];
        return new ConflictError(
          'UNIQUE_CONSTRAINT_VIOLATION',
          'Ya existe un registro con esos datos',
          // Se exponen los campos, no el nombre del índice: el cliente necesita saber
          // qué campo marcar en rojo, no cómo se llama el índice en PostgreSQL.
          { fields: fields.filter((f) => f !== 'tenantId' && f !== 'deletedAt') },
        );
      }

      case 'P2025':
        return new EntityNotFoundError(entityHint, 'desconocido');

      case 'P2003':
        return new BusinessRuleViolationError(
          'REFERENCED_ENTITY_MISSING',
          'Alguno de los elementos referenciados no existe',
        );

      case 'P2014':
        // Se intenta borrar algo de lo que cuelgan otros registros. Con soft delete no
        // debería ocurrir; si ocurre, es que alguien ha hecho un borrado físico.
        return new BusinessRuleViolationError(
          'ENTITY_IN_USE',
          'No se puede eliminar: hay registros que dependen de este elemento',
        );

      default:
        break;
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // Una consulta mal construida es un fallo de programación, no del usuario. Se deja
    // escapar para que el filtro global lo registre como 500 con su correlationId.
    return error;
  }

  return error instanceof Error ? error : new Error(rawMessage);
}

/** Envuelve una operación de repositorio traduciendo cualquier fallo de persistencia. */
export async function withMappedErrors<T>(entityHint: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapPrismaError(error, entityHint);
  }
}
