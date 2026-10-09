import type { AccessTokenClaims } from '../../application/ports';
import { WILDCARD_PERMISSION } from '../../domain/authorization';

/**
 * Cuánto vale `includeDeleted` para quien pregunta (ADR-0004).
 *
 * Ver lo dado de baja es parte de poder restaurarlo, así que exige el permiso `*.restore`
 * del recurso; sin él el parámetro se ignora en silencio, como documenta `PageQueryDto`.
 * Leer no basta: una profesional que puede ver la agenda no tiene por qué ver las fichas
 * de las clientas que el salón dio de baja.
 */
export const includeDeletedFor = (
  requested: boolean | undefined,
  user: AccessTokenClaims,
  restorePermission: string,
): boolean =>
  requested === true &&
  (user.permissions.includes(restorePermission) || user.permissions.includes(WILDCARD_PERMISSION));
