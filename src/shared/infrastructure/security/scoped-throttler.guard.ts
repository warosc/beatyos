import { Inject, Injectable, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';

import { TOKEN_SIGNER, type TokenSigner } from '../../application/ports';

/**
 * Guard de límites de peticiones con throttlers de ámbito acotado.
 *
 * ── El problema que resuelve ───────────────────────────────────────────────────────
 *
 * `ThrottlerModule` aplica **todos** los throttlers nombrados a **todas** las rutas. Un
 * throttler `auth` de 5 peticiones cada 15 minutos, pensado para el formulario de acceso,
 * acaba limitando la API entera a 5 peticiones cada 15 minutos.
 *
 * El síntoma es engañoso: en desarrollo, con un solo usuario haciendo clic, no se nota
 * nunca. En producción, la primera recepcionista con trabajo real se queda fuera del
 * sistema a los dos minutos, y el error que ve —429— no señala en absoluto a la causa.
 *
 * Se detectó porque la suite de integración empezó a devolver 429 en tests que no tenían
 * nada que ver con autenticación. Es exactamente el tipo de fallo que los tests de
 * integración existen para encontrar y que los unitarios no pueden ver.
 *
 * ── La solución ────────────────────────────────────────────────────────────────────
 *
 * Los throttlers cuyo nombre figura en `SCOPED_THROTTLERS` se aplican **solo** donde el
 * endpoint lo pide con `@ApplyThrottler('auth')`. El resto siguen siendo globales.
 *
 * El sentido por defecto importa: un throttler de ámbito acotado que se olvide de
 * declarar deja el endpoint *sin* ese límite extra, nunca la API entera *con* él. El
 * fallo se degrada a "este endpoint es menos estricto de lo previsto" y no a "el
 * producto no funciona".
 *
 * ── A quién se cuenta ──────────────────────────────────────────────────────────────
 *
 * Con sesión, a la **persona** (`sub` del token), no a la IP. Todo el salón llega a la API
 * desde el contenedor web, así que por IP compartían un solo cupo: con dos o tres equipos
 * abiertos en la agenda aparecían 429 que nadie entendía. El token se verifica antes de
 * fiarse de él —este guard va antes que `JwtAuthGuard`—: con un `sub` sin verificar,
 * inventar tokens daría un cupo nuevo en cada petición. Sin sesión, o con un token que no
 * vale, se cuenta por IP como siempre.
 */

export const APPLIED_THROTTLERS_KEY = 'throttler:applied';

/**
 * Throttlers que solo actúan donde se declaran.
 *
 * `short`, `medium` y `long` quedan fuera a propósito: son la protección general y deben
 * cubrir todas las rutas sin que nadie tenga que acordarse de anotarlas.
 */
const SCOPED_THROTTLERS: ReadonlySet<string> = new Set(['auth']);

/** Activa en este endpoint un throttler de ámbito acotado. */
export const ApplyThrottler = (...names: string[]) => SetMetadata(APPLIED_THROTTLERS_KEY, names);

@Injectable()
export class ScopedThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const header = (req.headers as Record<string, unknown> | undefined)?.authorization;
    const [scheme, token] = typeof header === 'string' ? header.split(' ') : [];
    if (scheme === 'Bearer' && token) {
      try {
        const claims = await this.tokens.verifyAccess(token);
        return `user:${claims.sub}`;
      } catch {
        // Un token inválido no da cupo propio: cuenta por IP, y `JwtAuthGuard` lo rechaza.
      }
    }
    return super.getTracker(req);
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const name = request.throttler.name;

    if (name && SCOPED_THROTTLERS.has(name) && !this.isDeclared(request.context, name)) {
      // `true` significa "esta comprobación pasa", no "salta todas": los demás
      // throttlers de la cadena siguen evaluándose con normalidad.
      return true;
    }

    return super.handleRequest(request);
  }

  private isDeclared(context: ExecutionContext, name: string): boolean {
    const declared =
      this.reflector.getAllAndOverride<string[]>(APPLIED_THROTTLERS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    return declared.includes(name);
  }
}
