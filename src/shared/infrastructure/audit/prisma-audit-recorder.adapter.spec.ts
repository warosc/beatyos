import { Logger } from '@nestjs/common';

import { RequestContextStore } from '../context/request-context';
import type { PrismaService } from '../persistence/prisma/prisma.service';
import { PrismaAuditRecorder } from './prisma-audit-recorder.adapter';

/**
 * Registro de auditoría (ADR-0004).
 *
 * Lo que estos tests protegen, sobre todo, es que **la auditoría no se convierta en una
 * vulnerabilidad**. Guardar el "antes" y el "después" de una fila de `User` significa
 * copiar el hash de su contraseña a una tabla que muchos más roles pueden leer y que
 * nadie puede borrar. La redacción no es un detalle: es la razón de que esto sea seguro.
 */
describe('PrismaAuditRecorder', () => {
  interface Captured {
    data: Record<string, unknown>;
  }

  const recorderWith = (
    onCreate: (args: Captured) => Promise<unknown> = () => Promise.resolve({}),
  ) => {
    const captured: Captured[] = [];

    const prisma = {
      client: {
        auditLog: {
          create: (args: Captured) => {
            captured.push(args);
            return onCreate(args);
          },
        },
      },
    } as unknown as PrismaService;

    return { recorder: new PrismaAuditRecorder(prisma), captured };
  };

  const dataOf = (captured: Captured[]): Record<string, unknown> => captured[0].data;

  describe('contexto', () => {
    it('toma actor, salón, IP y correlación del contexto de la petición', async () => {
      const { recorder, captured } = recorderWith();

      // Pasarlos a mano en cada llamada garantizaría que alguna se quedase sin ellos, y
      // una entrada de auditoría sin actor no sirve para nada.
      await RequestContextStore.run(
        {
          tenantId: 't-1',
          userId: 'u-1',
          userEmail: 'ana@salon.es',
          ipAddress: '10.0.0.1',
          userAgent: 'Firefox',
          correlationId: 'traza-1',
        },
        () => recorder.record({ action: 'CREATE', entityType: 'Client', entityId: 'c-1' }),
      );

      expect(dataOf(captured)).toMatchObject({
        tenantId: 't-1',
        actorId: 'u-1',
        actorEmail: 'ana@salon.es',
        ipAddress: '10.0.0.1',
        userAgent: 'Firefox',
        correlationId: 'traza-1',
        action: 'CREATE',
        entityType: 'Client',
        entityId: 'c-1',
      });
    });

    it('registra sucesos anteriores a la autenticación', async () => {
      const { recorder, captured } = recorderWith();

      // Un intento de acceso fallido todavía no tiene salón ni actor, y es justo el que
      // más interesa registrar.
      await recorder.record({ action: 'LOGIN_FAILED', entityType: 'User' });

      expect(dataOf(captured)).toMatchObject({ tenantId: null, actorId: null });
    });

    it('sin entityId lo guarda como nulo, no como undefined', async () => {
      const { recorder, captured } = recorderWith();
      await recorder.record({ action: 'EXPORT', entityType: 'Client' });
      expect(dataOf(captured).entityId).toBeNull();
    });
  });

  describe('redacción de datos sensibles', () => {
    it('nunca persiste el hash de una contraseña', async () => {
      const { recorder, captured } = recorderWith();

      await recorder.record({
        action: 'UPDATE',
        entityType: 'User',
        before: { email: 'ana@salon.es', passwordHash: '$argon2id$v=19$secreto' },
        after: { email: 'ana@salon.es', passwordHash: '$argon2id$v=19$otro' },
      });

      const serialized = JSON.stringify(dataOf(captured));
      expect(serialized).not.toContain('argon2id');
      expect(serialized).toContain('[redactado]');
      // El resto del diff sí se conserva: la auditoría sigue sirviendo.
      expect(serialized).toContain('ana@salon.es');
    });

    it('redacta todos los campos sensibles conocidos', async () => {
      const { recorder, captured } = recorderWith();

      await recorder.record({
        action: 'UPDATE',
        entityType: 'User',
        after: {
          password: 'x',
          newPassword: 'x',
          currentPassword: 'x',
          token: 'x',
          tokenHash: 'x',
          accessToken: 'x',
          refreshToken: 'x',
          secret: 'x',
          apiKey: 'x',
          authorization: 'x',
        },
      });

      const after = dataOf(captured).after as Record<string, string>;
      expect(Object.values(after).every((value) => value === '[redactado]')).toBe(true);
    });

    it('redacta también en profundidad, dentro de objetos y listas', async () => {
      const { recorder, captured } = recorderWith();

      // El `before` de una factura lleva sus líneas: basta un campo sensible en un nivel
      // profundo para filtrarlo.
      await recorder.record({
        action: 'UPDATE',
        entityType: 'Invoice',
        before: {
          lines: [{ description: 'Corte', meta: { apiKey: 'clave-de-pasarela' } }],
        },
      });

      const serialized = JSON.stringify(dataOf(captured));
      expect(serialized).not.toContain('clave-de-pasarela');
      expect(serialized).toContain('Corte');
    });

    it('convierte las fechas a ISO', async () => {
      const { recorder, captured } = recorderWith();

      await recorder.record({
        action: 'UPDATE',
        entityType: 'Client',
        after: { lastVisitAt: new Date('2026-09-02T10:00:00.000Z') },
      });

      expect((dataOf(captured).after as Record<string, unknown>).lastVisitAt).toBe(
        '2026-09-02T10:00:00.000Z',
      );
    });

    it('corta las estructuras demasiado anidadas en lugar de colgarse', async () => {
      const { recorder, captured } = recorderWith();

      // Una referencia cíclica colgaría el proceso; un objeto muy anidado haría la
      // entrada inmanejable.
      let deep: Record<string, unknown> = { value: 'fondo' };
      for (let i = 0; i < 15; i += 1) deep = { nested: deep };

      await recorder.record({ action: 'UPDATE', entityType: 'Client', after: deep });

      expect(JSON.stringify(dataOf(captured))).toContain('demasiado profundo');
    });

    it('trata un diff ausente como ausente, no como null', async () => {
      const { recorder, captured } = recorderWith();
      await recorder.record({ action: 'DELETE', entityType: 'Client', entityId: 'c-1' });

      expect(dataOf(captured).before).toBeUndefined();
      expect(dataOf(captured).after).toBeUndefined();
    });

    it('conserva los valores primitivos tal cual', async () => {
      const { recorder, captured } = recorderWith();

      await recorder.record({
        action: 'UPDATE',
        entityType: 'Client',
        after: { loyaltyPoints: 120, marketingConsent: true, notes: 'texto' },
      });

      expect(dataOf(captured).after).toEqual({
        loyaltyPoints: 120,
        marketingConsent: true,
        notes: 'texto',
      });
    });
  });

  describe('tolerancia a fallos', () => {
    it('un fallo al auditar no tumba la operación de negocio', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { recorder } = recorderWith(() => Promise.reject(new Error('base caída')));

      // La clienta ya está en la silla y la cita tiene que quedar guardada. Se registra
      // con severidad alta para que la pérdida de trazabilidad sea visible.
      await expect(
        recorder.record({ action: 'CREATE', entityType: 'Appointment', entityId: 'a-1' }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No se pudo registrar'));
      errorSpy.mockRestore();
    });

    it('el aviso identifica la operación que no pudo auditarse', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { recorder } = recorderWith(() => Promise.reject(new Error('base caída')));

      await recorder.record({ action: 'DELETE', entityType: 'Invoice', entityId: 'inv-9' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inv-9'));
      errorSpy.mockRestore();
    });
  });
});
