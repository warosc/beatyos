import { randomUUID } from 'node:crypto';

import type {
  AccessTokenClaims,
  AuditEntry,
  AuditRecorder,
  PasswordHasher,
  RefreshTokenClaims,
  TokenSigner,
} from '@shared/application/ports';
import type {
  CreateRefreshTokenInput,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from '@core/auth/domain/refresh-token.repository';

/**
 * Dobles de los puertos de autenticación (ADR-0009).
 *
 * Sustituyen exclusivamente lo que sería lento o indeterminista en un test —Argon2 son
 * ~50 ms por verificación, y multiplicado por una suite entera son minutos— manteniendo
 * el **comportamiento observable** del puerto real.
 */

/**
 * Hasher de mentira, rápido y reversible.
 *
 * Que el "hash" sea legible es intencionado: cuando un test falla, se ve de un vistazo
 * qué contraseña se guardó, en lugar de comparar dos cadenas opacas de Argon2.
 *
 * Cuenta las llamadas a `verifyDummy` para poder afirmar que el login gasta el mismo
 * trabajo con un correo desconocido que con uno real: sin esa comprobación, la defensa
 * contra enumeración por tiempo se rompería en cualquier refactor sin que nadie lo note.
 */
export class FakePasswordHasher implements PasswordHasher {
  public dummyVerifications = 0;
  public hashCalls = 0;
  /** Fuerza a `needsRehash` a devolver `true`, para probar el rehash silencioso. */
  public forceRehash = false;

  async hash(plain: string): Promise<string> {
    this.hashCalls += 1;
    return `$fake$${plain}`;
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return hash === `$fake$${plain}`;
  }

  async verifyDummy(): Promise<void> {
    this.dummyVerifications += 1;
  }

  needsRehash(): boolean {
    return this.forceRehash;
  }
}

/**
 * Firmador de tokens en memoria.
 *
 * No produce JWT reales: produce identificadores opacos con sus claims guardados aparte.
 * Probar la criptografía de `jsonwebtoken` no es responsabilidad de esta suite —eso lo
 * cubren los tests de integración, que usan el firmador de verdad—. Aquí lo que se
 * prueba es la **lógica de sesión**: qué se firma, cuándo se rota y qué se revoca.
 */
export class FakeTokenSigner implements TokenSigner {
  private readonly access = new Map<string, AccessTokenClaims>();
  private readonly refresh = new Map<string, RefreshTokenClaims>();

  public accessTtlMs = 15 * 60_000;
  public refreshTtlMs = 7 * 24 * 60 * 60_000;
  public now = () => new Date();

  async signAccess(claims: Omit<AccessTokenClaims, 'jti'>) {
    const jti = randomUUID();
    const token = `access.${jti}`;
    this.access.set(token, { ...claims, jti });
    return { token, expiresAt: new Date(this.now().getTime() + this.accessTtlMs), jti };
  }

  async signRefresh(claims: Omit<RefreshTokenClaims, 'jti'>) {
    const jti = randomUUID();
    const token = `refresh.${jti}`;
    this.refresh.set(token, { ...claims, jti });
    return { token, expiresAt: new Date(this.now().getTime() + this.refreshTtlMs), jti };
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    const claims = this.access.get(token);
    if (!claims) throw new Error('Token de acceso no válido');
    return claims;
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    const claims = this.refresh.get(token);
    if (!claims) throw new Error('Token de refresco no válido');
    return claims;
  }
}

/** Almacén de refresh tokens en memoria, con la misma semántica de rotación y familia. */
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private readonly store = new Map<string, RefreshTokenRecord>();

  get all(): RefreshTokenRecord[] {
    return [...this.store.values()];
  }

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      ...input,
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      createdAt: new Date(),
    };
    this.store.set(input.id, record);
    return record;
  }

  async findByJti(jti: string): Promise<RefreshTokenRecord | null> {
    return this.all.find((record) => record.jti === jti) ?? null;
  }

  async rotate(id: string, replacedById: string, now: Date): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    this.store.set(id, {
      ...record,
      revokedAt: now,
      revokedReason: 'ROTATED',
      replacedById,
    });
  }

  async revoke(id: string, reason: string, now: Date): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    this.store.set(id, { ...record, revokedAt: now, revokedReason: reason });
  }

  async revokeFamily(familyId: string, reason: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const record of this.all) {
      // Se revocan también los ya revocados por rotación: la razón cambia a la del
      // incidente, que es lo que después se busca en la auditoría.
      if (record.familyId === familyId) {
        this.store.set(record.id, { ...record, revokedAt: now, revokedReason: reason });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeAllForUser(userId: string, reason: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const record of this.all) {
      if (record.userId === userId && record.revokedAt === null) {
        this.store.set(record.id, { ...record, revokedAt: now, revokedReason: reason });
        revoked += 1;
      }
    }
    return revoked;
  }

  async deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    for (const record of this.all) {
      if (record.expiresAt < before) {
        this.store.delete(record.id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

/** Auditoría en memoria. Permite afirmar qué se registró, que es parte del contrato. */
export class InMemoryAuditRecorder implements AuditRecorder {
  public readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  actionsFor(entityType: string): string[] {
    return this.entries.filter((e) => e.entityType === entityType).map((e) => e.action);
  }

  has(action: string): boolean {
    return this.entries.some((e) => e.action === action);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
