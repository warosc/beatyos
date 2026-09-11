import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuditEntry, AuditRecorder } from '../../application/ports';
import { RequestContextStore } from '../context/request-context';
import { PrismaService } from '../persistence/prisma/prisma.service';
import { QueryScopeStore } from '../persistence/prisma/query-scope';

/**
 * Escritura del registro de auditoría (ADR-0004).
 *
 * El actor, el salón, la IP y el identificador de correlación se toman del contexto de
 * petición, no de los parámetros: pasarlos a mano en cada llamada garantizaría que
 * alguna se quedase sin ellos, y una entrada de auditoría sin actor no sirve de nada.
 */

/**
 * Campos que nunca se persisten en el diff.
 *
 * Auditar es guardar el "antes" y el "después" de una fila. Si la fila es `User`, ese
 * "antes" incluye el hash de la contraseña, y acabaría copiado en una tabla que muchos
 * más roles pueden leer que la original. La auditoría dejaría de ser un control y
 * pasaría a ser una vulnerabilidad.
 */
const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'plainPassword',
  'newPassword',
  'currentPassword',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
]);

const REDACTION_MARK = '[redactado]';

@Injectable()
export class PrismaAuditRecorder implements AuditRecorder {
  private readonly logger = new Logger(PrismaAuditRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    const context = RequestContextStore.get();

    try {
      // La auditoría se escribe sin filtro de tenant porque su `tenantId` se fija aquí
      // de forma explícita, y porque debe poder registrar también sucesos previos a la
      // autenticación —un intento de acceso fallido no tiene salón todavía.
      await QueryScopeStore.crossTenant(() =>
        this.prisma.client.auditLog.create({
          data: {
            tenantId: context.tenantId,
            actorId: context.userId,
            actorEmail: context.userEmail,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId ?? null,
            before: this.redact(entry.before),
            after: this.redact(entry.after),
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            correlationId: context.correlationId,
            metadata: this.redact(entry.metadata) ?? undefined,
            occurredAt: new Date(),
          },
        }),
      );
    } catch (error) {
      // Un fallo al auditar no puede tumbar la operación de negocio: la clienta ya está
      // en la silla y la cita tiene que quedar guardada. Se registra con severidad alta
      // para que la pérdida de trazabilidad sea visible y se investigue.
      //
      // El equilibrio es discutible y depende del sector: donde la auditoría sea un
      // requisito legal duro, lo correcto sería lo contrario —abortar la operación. Para
      // un salón de belleza, no.
      this.logger.error(
        `No se pudo registrar la auditoría de ${entry.action} sobre ${entry.entityType}` +
          `${entry.entityId ? `#${entry.entityId}` : ''}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Copia el valor sustituyendo los campos sensibles, en profundidad.
   *
   * Se recorre también dentro de arrays y objetos anidados: un `before` de una factura
   * lleva sus líneas, y basta un campo sensible en un nivel profundo para filtrarlo.
   */
  private redact(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
    // Tope de profundidad: un objeto con referencias cíclicas colgaría el proceso, y una
    // estructura muy anidada haría la entrada de auditoría inmanejable.
    if (depth > 8) return '[demasiado profundo]';
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item, depth + 1) ?? null);
    }

    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
          key,
          REDACTED_FIELDS.has(key) ? REDACTION_MARK : (this.redact(nested, depth + 1) ?? null),
        ]),
      );
    }

    return value;
  }
}
