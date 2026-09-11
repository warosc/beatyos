import { Injectable } from '@nestjs/common';

import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import type {
  CreateRefreshTokenInput,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '../../domain/refresh-token.repository';

/**
 * Adaptador Prisma del almacén de refresh tokens.
 *
 * Todas sus operaciones van **sin filtro de salón**, y eso es correcto: el refresco de
 * sesión llega sin access token, luego el contexto de petición todavía no tiene tenant.
 * El aislamiento no se pierde porque el `jti` es un UUID imposible de adivinar y la
 * verificación del hash prueba la posesión del token: el `tenantId` se guarda como dato
 * de la sesión, no como filtro de acceso.
 *
 * Por eso `RefreshToken` figura en `TENANT_EXEMPT_MODELS`.
 */
@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const row = await withMappedErrors('Sesión', () =>
      this.prisma.client.refreshToken.create({
        data: {
          id: input.id,
          userId: input.userId,
          tenantId: input.tenantId,
          tokenHash: input.tokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
          jti: input.jti,
          userAgent: input.userAgent,
          ipAddress: input.ipAddress,
        },
      }),
    );

    return this.toRecord(row);
  }

  async findByJti(jti: string): Promise<RefreshTokenRecord | null> {
    const row = await withMappedErrors('Sesión', () =>
      this.prisma.client.refreshToken.findFirst({ where: { jti } }),
    );
    return row ? this.toRecord(row) : null;
  }

  async rotate(id: string, replacedById: string, now: Date): Promise<void> {
    await withMappedErrors('Sesión', () =>
      this.prisma.client.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'ROTATED', replacedById },
      }),
    );
  }

  async revoke(id: string, reason: string, now: Date): Promise<void> {
    await withMappedErrors('Sesión', () =>
      this.prisma.client.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      }),
    );
  }

  /**
   * Revoca la familia entera al detectar una reutilización.
   *
   * Alcanza también a los ya revocados por rotación, y no solo a los vivos: sobrescribir
   * el motivo deja escrito en la base que esa cadena estuvo comprometida, que es lo que
   * se busca al investigar el incidente semanas después.
   */
  async revokeFamily(familyId: string, reason: string, now: Date): Promise<number> {
    const result = await withMappedErrors('Sesión', () =>
      this.prisma.client.refreshToken.updateMany({
        where: { familyId },
        data: { revokedAt: now, revokedReason: reason },
      }),
    );
    return result.count;
  }

  async revokeAllForUser(userId: string, reason: string, now: Date): Promise<number> {
    const result = await QueryScopeStore.crossTenant(() =>
      withMappedErrors('Sesión', () =>
        this.prisma.client.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: reason },
        }),
      ),
    );
    return result.count;
  }

  /**
   * Purga de tokens caducados.
   *
   * La ejecuta una tarea programada, nunca el camino de la petición. Sin ella la tabla
   * crece indefinidamente: cada refresco añade una fila y ninguna se borra sola.
   */
  async deleteExpired(before: Date): Promise<number> {
    const result = await QueryScopeStore.crossTenant(() =>
      this.prisma.client.refreshToken.deleteMany({ where: { expiresAt: { lt: before } } }),
    );
    return result.count;
  }

  private toRecord(row: {
    id: string;
    jti: string;
    userId: string;
    tenantId: string | null;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
    replacedById: string | null;
    createdAt: Date;
  }): RefreshTokenRecord {
    return {
      id: row.id,
      jti: row.jti,
      userId: row.userId,
      tenantId: row.tenantId,
      tokenHash: row.tokenHash,
      familyId: row.familyId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
      replacedById: row.replacedById,
      createdAt: row.createdAt,
    };
  }
}
