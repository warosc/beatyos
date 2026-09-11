import { parseCorsOrigins, validateEnv } from './env.schema';

/**
 * La validación de entorno es la primera línea de defensa del despliegue: aborta el
 * arranque cuando la configuración es peligrosa, en lugar de dejar que el fallo aparezca
 * horas después dentro de una función de firma.
 *
 * Estos tests describen exactamente qué se considera peligroso y qué no. Es importante
 * que sean precisos en ambos sentidos: un validador que rechaza configuraciones válidas
 * se acaba desactivando, y entonces no protege de nada.
 */
describe('validateEnv', () => {
  const randomSecret = (seed: string): string => `${seed}_xK9mQ2pR7vT4wY6zA8bC1dE3fG5hJ0lN`;

  const baseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
    JWT_ACCESS_SECRET: randomSecret('acc'),
    JWT_REFRESH_SECRET: randomSecret('ref'),
  };

  describe('valores por defecto', () => {
    it('rellena todo lo opcional con valores razonables', () => {
      const env = validateEnv({ ...baseEnv });

      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3000);
      expect(env.JWT_ACCESS_TTL).toBe('15m');
      expect(env.ARGON2_MEMORY_COST).toBe(19_456);
      expect(env.DEFAULT_CURRENCY).toBe('GTQ');
    });

    it('convierte los números que llegan como cadena', () => {
      // Todo lo que viene del entorno es texto; sin coerción, `PORT` sería la cadena
      // "3000" y `app.listen` fallaría de forma poco obvia.
      const env = validateEnv({ ...baseEnv, PORT: '8080', THROTTLE_SHORT_LIMIT: '25' });

      expect(env.PORT).toBe(8080);
      expect(env.THROTTLE_SHORT_LIMIT).toBe(25);
    });

    it('normaliza la moneda a mayúsculas', () => {
      expect(validateEnv({ ...baseEnv, DEFAULT_CURRENCY: 'eur' }).DEFAULT_CURRENCY).toBe('EUR');
    });

    it('interpreta SWAGGER_ENABLED como booleano', () => {
      expect(validateEnv({ ...baseEnv, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
      expect(validateEnv({ ...baseEnv, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
    });
  });

  describe('validaciones estructurales', () => {
    it('exige una URL de PostgreSQL', () => {
      expect(() => validateEnv({ ...baseEnv, DATABASE_URL: 'no-es-una-url' })).toThrow(
        /DATABASE_URL/,
      );
      expect(() =>
        validateEnv({ ...baseEnv, DATABASE_URL: 'mysql://user:pass@localhost:3306/db' }),
      ).toThrow(/PostgreSQL/);
    });

    it('exige secretos de al menos 32 caracteres', () => {
      expect(() => validateEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'corto' })).toThrow(/32/);
    });

    it('rechaza que ambos secretos coincidan', () => {
      const same = randomSecret('mismo');

      // Con un secreto compartido, un refresh token de siete días podría presentarse como
      // access y saltarse la ventana de quince minutos que es toda la defensa (ADR-0005).
      expect(() =>
        validateEnv({ ...baseEnv, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }),
      ).toThrow(/distinto de JWT_ACCESS_SECRET/);
    });

    it('valida el formato de los TTL', () => {
      expect(() => validateEnv({ ...baseEnv, JWT_ACCESS_TTL: '15 minutos' })).toThrow(/15m/);
    });

    it('enumera TODOS los problemas de una vez', () => {
      // Arrancar cinco veces seguidas para descubrir cinco variables mal puestas es una
      // pérdida de tiempo evitable.
      try {
        validateEnv({ DATABASE_URL: 'roto', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y' });
        fail('se esperaba un error de validación');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('DATABASE_URL');
        expect(message).toContain('JWT_ACCESS_SECRET');
        expect(message).toContain('JWT_REFRESH_SECRET');
      }
    });

    it('el mensaje remite a la plantilla', () => {
      expect(() => validateEnv({})).toThrow(/\.env\.example/);
    });
  });

  describe('endurecimiento en producción', () => {
    const productionEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://salon.example.com',
      SWAGGER_ENABLED: 'false',
    };

    it('acepta una configuración de producción correcta', () => {
      expect(() => validateEnv(productionEnv)).not.toThrow();
    });

    it('acepta un secreto aleatorio aunque contenga la palabra "secreto"', () => {
      // La primera versión del validador rechazaba cualquier valor con «secret» dentro y
      // descartaba claves perfectamente válidas. Este test fija que eso no vuelva.
      expect(() =>
        validateEnv({
          ...productionEnv,
          JWT_ACCESS_SECRET: 'mi_secreto_xK9mQ2pR7vT4wY6zA8bC1dE3fG5hJ0lN',
        }),
      ).not.toThrow();
    });

    it('rechaza el marcador de la plantilla', () => {
      expect(() =>
        validateEnv({
          ...productionEnv,
          JWT_ACCESS_SECRET: 'cambiame_por_un_secreto_de_al_menos_32_caracteres',
        }),
      ).toThrow(/ejemplo/);
    });

    it('rechaza un secreto con poca variedad de caracteres', () => {
      // Un secreto aleatorio de 32 bytes usa decenas de símbolos distintos; `aaaa…`, dos.
      expect(() => validateEnv({ ...productionEnv, JWT_ACCESS_SECRET: 'a'.repeat(40) })).toThrow(
        /no parece aleatorio/,
      );
    });

    it('exige una lista blanca de CORS', () => {
      expect(() => validateEnv({ ...productionEnv, CORS_ORIGINS: '' })).toThrow(/lista blanca/);
      expect(() => validateEnv({ ...productionEnv, CORS_ORIGINS: '*' })).toThrow(/lista blanca/);
    });

    it('exige desactivar Swagger', () => {
      // No es un fallo de seguridad por sí mismo, pero publica el mapa completo de la API.
      expect(() => validateEnv({ ...productionEnv, SWAGGER_ENABLED: 'true' })).toThrow(/Swagger/);
    });

    it('en desarrollo no aplica ninguna de esas restricciones', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          NODE_ENV: 'development',
          CORS_ORIGINS: '',
          SWAGGER_ENABLED: 'true',
        }),
      ).not.toThrow();
    });
  });
});

describe('parseCorsOrigins', () => {
  it('trocea, recorta y descarta vacíos', () => {
    expect(parseCorsOrigins(' https://a.es , https://b.es ,, ')).toEqual([
      'https://a.es',
      'https://b.es',
    ]);
  });

  it('una cadena vacía produce una lista vacía', () => {
    // El arranque avisa de esto: con la lista vacía ningún navegador podrá consumir la API.
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });
});
