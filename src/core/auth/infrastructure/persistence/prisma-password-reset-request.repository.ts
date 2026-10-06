import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import type {
  PasswordResetRequestRepository,
  PendingPasswordResetRequest,
} from '../../domain/password-reset-request.repository';

@Injectable()
export class PrismaPasswordResetRequestRepository implements PasswordResetRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Entre inquilinos porque llega del formulario público, sin sesión; el `tenantId` lo fija
   * el caso de uso a partir del usuario encontrado.
   *
   * La consulta previa evita el error en el caso normal; el índice único parcial
   * `password_reset_requests_one_pending_per_user` cubre la carrera de dos peticiones
   * simultáneas, y su violación significa justo lo que se quería: ya hay un aviso.
   */
  async open(request: { id: string; tenantId: string; userId: string; now: Date }) {
    await QueryScopeStore.crossTenant(async () => {
      const pending = await this.prisma.client.passwordResetRequest.findFirst({
        where: { userId: request.userId, status: 'PENDING' },
        select: { id: true },
      });
      if (pending) return;
      try {
        await this.prisma.client.passwordResetRequest.create({
          data: {
            id: request.id,
            tenantId: request.tenantId,
            userId: request.userId,
            createdAt: request.now,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
        throw error;
      }
    });
  }

  async listPending(): Promise<PendingPasswordResetRequest[]> {
    const rows = await this.prisma.client.passwordResetRequest.findMany({
      // Un usuario dado de baja o desactivado no va a poder entrar aunque se le asigne
      // contraseña: su aviso no le sirve a nadie en la bandeja.
      where: { status: 'PENDING', user: { deletedAt: null, status: 'ACTIVE' } },
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      email: row.user.email,
      fullName: `${row.user.firstName} ${row.user.lastName}`,
      requestedAt: row.createdAt,
    }));
  }

  async resolveForUser(userId: string, actorId: string, now: Date) {
    await this.prisma.client.passwordResetRequest.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'RESOLVED', resolvedAt: now, resolvedBy: actorId },
    });
  }

  async dismiss(id: string, actorId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.client.passwordResetRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'DISMISSED', resolvedAt: now, resolvedBy: actorId },
    });
    return result.count === 1;
  }
}
