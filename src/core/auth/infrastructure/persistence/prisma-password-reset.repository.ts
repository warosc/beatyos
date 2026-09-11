import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import type { PasswordResetRepository } from '../../domain/password-reset.repository';

@Injectable()
export class PrismaPasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async replaceForUser(record: { id: string; userId: string; tokenHash: string; expiresAt: Date }) {
    await this.prisma.transaction(async () => {
      await this.prisma.client.passwordResetToken.deleteMany({
        where: { userId: record.userId, usedAt: null },
      });
      await this.prisma.client.passwordResetToken.create({ data: record });
    });
  }

  async findByHash(tokenHash: string) {
    return this.prisma.client.passwordResetToken.findUnique({ where: { tokenHash } });
  }

  async markUsed(id: string, usedAt: Date): Promise<boolean> {
    const result = await this.prisma.client.passwordResetToken.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: usedAt } },
      data: { usedAt },
    });
    return result.count === 1;
  }
}
