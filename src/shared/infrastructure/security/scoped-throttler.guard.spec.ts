import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';

import { APPLIED_THROTTLERS_KEY, ScopedThrottlerGuard } from './scoped-throttler.guard';

/**
 * Guard de límites con throttlers de ámbito acotado.
 *
 * Existe por un fallo real: `ThrottlerModule` aplica **todos** los throttlers nombrados a
 * **todas** las rutas, de modo que una ventana `auth` de 5 peticiones cada 15 minutos
 * —pensada para el formulario de acceso— acababa limitando la API entera a 5 peticiones
 * cada 15 minutos. En desarrollo no se nota; en producción, la primera recepcionista con
 * trabajo real se queda fuera a los dos minutos.
 *
 * Estos tests fijan el comportamiento para que no vuelva.
 */
describe('ScopedThrottlerGuard', () => {
  const buildGuard = (declaredThrottlers?: string[]) => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === APPLIED_THROTTLERS_KEY ? declaredThrottlers : undefined,
    } as unknown as Reflector;

    const options = { throttlers: [] } as unknown as ThrottlerModuleOptions;
    const storage = {} as unknown as ThrottlerStorage;

    return new ScopedThrottlerGuard(options, storage, reflector);
  };

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class Probe {},
  } as unknown as ExecutionContext;

  /**
   * Espía la comprobación real, que vive en la clase padre.
   *
   * Se instrumenta el prototipo de `ThrottlerGuard` y no la instancia: la subclase
   * delega con `super.handleRequest`, que resuelve por el prototipo del padre y no vería
   * una sustitución hecha sobre el objeto.
   */
  const spyOnParent = () =>
    jest
      .spyOn(
        ThrottlerGuard.prototype as unknown as {
          handleRequest: (r: ThrottlerRequest) => Promise<boolean>;
        },
        'handleRequest',
      )
      .mockResolvedValue(true);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const requestFor = (throttlerName: string | undefined): ThrottlerRequest =>
    ({ context, throttler: { name: throttlerName } }) as unknown as ThrottlerRequest;

  /** Acceso al método protegido, que es justamente lo que esta clase sobrescribe. */
  const handle = (guard: ScopedThrottlerGuard, request: ThrottlerRequest): Promise<boolean> =>
    (guard as unknown as { handleRequest(r: ThrottlerRequest): Promise<boolean> }).handleRequest(
      request,
    );

  it('salta el throttler `auth` en un endpoint que no lo declara', async () => {
    const parent = spyOnParent();
    const guard = buildGuard(undefined);

    await expect(handle(guard, requestFor('auth'))).resolves.toBe(true);
    // Es el corazón del arreglo: sin declararlo, la ventana estrecha no se aplica.
    expect(parent).not.toHaveBeenCalled();
  });

  it('aplica el throttler `auth` donde sí se declara', async () => {
    const parent = spyOnParent();
    const guard = buildGuard(['auth']);

    await handle(guard, requestFor('auth'));

    expect(parent).toHaveBeenCalled();
  });

  it('los throttlers generales siguen siendo globales', async () => {
    // `short`, `medium` y `long` son la protección general y deben cubrir todas las rutas
    // sin que nadie tenga que acordarse de anotarlas.
    for (const name of ['short', 'medium', 'long']) {
      const parent = spyOnParent();
      const guard = buildGuard(undefined);

      await handle(guard, requestFor(name));

      expect(parent).toHaveBeenCalled();
    }
  });

  it('un throttler sin nombre se trata como general', async () => {
    const parent = spyOnParent();
    const guard = buildGuard(undefined);

    await handle(guard, requestFor(undefined));

    expect(parent).toHaveBeenCalled();
  });

  it('declarar otro throttler no activa el `auth`', async () => {
    const parent = spyOnParent();
    const guard = buildGuard(['otro']);

    await handle(guard, requestFor('auth'));

    expect(parent).not.toHaveBeenCalled();
  });

  it('saltar un throttler no desactiva los demás de la cadena', async () => {
    // Devolver `true` significa "esta comprobación pasa", no "salta todas": los otros
    // throttlers se siguen evaluando con normalidad.
    const parent = spyOnParent();
    const guard = buildGuard(undefined);

    await handle(guard, requestFor('auth'));
    await handle(guard, requestFor('short'));

    expect(parent).toHaveBeenCalledTimes(1);
  });
});
