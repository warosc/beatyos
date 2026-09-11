import { Injectable, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';

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
