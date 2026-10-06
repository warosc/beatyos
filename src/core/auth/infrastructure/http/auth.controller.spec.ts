import type { ConfigService } from '@nestjs/config';

import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import type { RequestPasswordResetUseCase } from '../../application/password-reset.use-cases';
import { AuthController } from './auth.controller';

/**
 * El enlace de recuperación en la respuesta es un atajo para la suite. Fuera de ella
 * entregaría la cuenta a quien conozca el correo: la demo corre en `development`, así
 * que «no es producción» no basta como criterio.
 */
describe('AuthController · olvidé mi contraseña', () => {
  const controllerIn = (nodeEnv: Env['NODE_ENV']) => {
    const requestPasswordReset = {
      execute: async () => ({ token: 'token-de-prueba' }),
    } as unknown as RequestPasswordResetUseCase;
    const config = { get: () => nodeEnv } as unknown as ConfigService<Env, true>;
    const unused = undefined as never;
    return new AuthController(
      unused,
      unused,
      unused,
      unused,
      unused,
      requestPasswordReset,
      unused,
      config,
    );
  };

  it.each(['development', 'production'] as const)('no devuelve el enlace en %s', async (env) => {
    const response = await controllerIn(env).forgotPassword({ email: 'ana@example.com' });

    expect(response).not.toHaveProperty('resetPath');
  });

  it('lo devuelve en el entorno de pruebas', async () => {
    const response = await controllerIn('test').forgotPassword({ email: 'ana@example.com' });

    expect(response).toHaveProperty('resetPath', '/reset-password?token=token-de-prueba');
  });
});
