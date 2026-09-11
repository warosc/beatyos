export interface PasswordResetRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface PasswordResetRepository {
  replaceForUser(record: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findByHash(tokenHash: string): Promise<PasswordResetRecord | null>;
  markUsed(id: string, usedAt: Date): Promise<boolean>;
}

export const PASSWORD_RESET_REPOSITORY = Symbol('PasswordResetRepository');
