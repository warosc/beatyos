import type { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema';
import { Argon2PasswordHasher } from './argon2-password-hasher.adapter';

/**
 * Hashing real de contraseñas (ADR-0005).
 *
 * Se usa Argon2 de verdad, no un doble: lo que interesa comprobar es precisamente el
 * comportamiento del algoritmo —el formato PHC, la sal aleatoria, la detección de
 * parámetros obsoletos—, y un doble no probaría nada de eso.
 *
 * Los parámetros son los mínimos que admite el esquema (8 MiB, 1 pasada). En producción
 * son 19 MiB y 2 pasadas; aquí multiplicarlo por cada test costaría minutos de suite sin
 * comprobar nada distinto.
 */
describe('Argon2PasswordHasher', () => {
  const configWith = (memoryCost: number, timeCost = 1, parallelism = 1) =>
    ({
      get: (key: keyof Env) =>
        ({
          ARGON2_MEMORY_COST: memoryCost,
          ARGON2_TIME_COST: timeCost,
          ARGON2_PARALLELISM: parallelism,
        })[key as string],
    }) as unknown as ConfigService<Env, true>;

  const hasher = new Argon2PasswordHasher(configWith(8_192));

  describe('hash y verificación', () => {
    it('produce un hash en formato PHC de Argon2id', async () => {
      const hash = await hasher.hash('ContrasenaSegura1');

      expect(hash).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
      // El hash contiene los parámetros: por eso una contraseña antigua sigue
      // verificándose aunque se endurezca la configuración.
      expect(hash).not.toContain('ContrasenaSegura1');
    });

    it('dos hashes de la misma contraseña son distintos', async () => {
      // Sal aleatoria: sin ella, dos usuarios con la misma contraseña tendrían el mismo
      // hash y una tabla precalculada los rompería a los dos de una vez.
      const [first, second] = await Promise.all([
        hasher.hash('MismaClave123'),
        hasher.hash('MismaClave123'),
      ]);

      expect(first).not.toBe(second);
      expect(await hasher.verify(first, 'MismaClave123')).toBe(true);
      expect(await hasher.verify(second, 'MismaClave123')).toBe(true);
    });

    it('verifica correctamente y rechaza lo incorrecto', async () => {
      const hash = await hasher.hash('ContrasenaSegura1');

      expect(await hasher.verify(hash, 'ContrasenaSegura1')).toBe(true);
      expect(await hasher.verify(hash, 'ContrasenaSegura2')).toBe(false);
      expect(await hasher.verify(hash, '')).toBe(false);
    });

    it('un hash corrupto no revienta: responde que no valida', async () => {
      // Un hash de otro algoritmo o truncado por una migración a medias es una
      // credencial que no valida, no una caída del servicio.
      expect(await hasher.verify('esto-no-es-un-hash', 'loquesea')).toBe(false);
      expect(await hasher.verify('$2b$10$bcryptDeOtraEpoca', 'loquesea')).toBe(false);
    });

    it('admite caracteres no ASCII y contraseñas largas', async () => {
      const passphrase = 'Mi contraseña con ñ, acentos y emoji 💇‍♀️ 2026';
      const hash = await hasher.hash(passphrase);

      expect(await hasher.verify(hash, passphrase)).toBe(true);
    });
  });

  describe('límites de entrada', () => {
    it('rechaza una contraseña vacía', async () => {
      await expect(hasher.hash('')).rejects.toThrow(/vacía/);
    });

    it('rechaza entradas desmesuradas', async () => {
      // Sin tope, unas pocas peticiones con megabytes en el campo de contraseña agotan
      // la CPU: Argon2 es caro por diseño y esa es justamente su superficie de abuso.
      await expect(hasher.hash('a'.repeat(1025))).rejects.toThrow(/1 KB/);
    });

    it('admite exactamente el límite', async () => {
      await expect(hasher.hash('a'.repeat(1024))).resolves.toMatch(/^\$argon2id\$/);
    });
  });

  describe('rehash progresivo', () => {
    it('un hash con los parámetros actuales no necesita rehash', async () => {
      const hash = await hasher.hash('ContrasenaSegura1');
      expect(hasher.needsRehash(hash)).toBe(false);
    });

    it('detecta un hash creado con menos memoria', async () => {
      const weakHash = await new Argon2PasswordHasher(configWith(8_192)).hash('ContrasenaSegura1');
      const stricter = new Argon2PasswordHasher(configWith(19_456));

      // Permite endurecer los parámetros de forma progresiva, rehasheando en cada acceso
      // correcto, sin una migración masiva que dejaría a todo el mundo fuera.
      expect(stricter.needsRehash(weakHash)).toBe(true);
    });

    it('detecta un hash creado con menos pasadas', async () => {
      const weakHash = await new Argon2PasswordHasher(configWith(8_192, 1)).hash('Clave1234567');
      expect(new Argon2PasswordHasher(configWith(8_192, 3)).needsRehash(weakHash)).toBe(true);
    });

    it('un hash de otro algoritmo siempre necesita rehash', async () => {
      // Es el camino de migración desde bcrypt: en el primer acceso correcto la
      // contraseña se rehashea con Argon2id y el hash antiguo desaparece.
      expect(hasher.needsRehash('$2b$10$hashDeBcrypt')).toBe(true);
      expect(hasher.needsRehash('')).toBe(true);
    });

    it('el hash rehasheado verifica la misma contraseña', async () => {
      const weakHash = await new Argon2PasswordHasher(configWith(8_192)).hash('Clave1234567');
      const stricter = new Argon2PasswordHasher(configWith(19_456));

      const rehashed = await stricter.hash('Clave1234567');

      expect(await stricter.verify(weakHash, 'Clave1234567')).toBe(true);
      expect(await stricter.verify(rehashed, 'Clave1234567')).toBe(true);
      expect(stricter.needsRehash(rehashed)).toBe(false);
    });
  });

  describe('defensa contra enumeración por tiempo', () => {
    it('verifyDummy realiza trabajo real y es reutilizable', async () => {
      // Sin esto, el login responde en microsegundos para un correo desconocido y en
      // decenas de milisegundos para uno conocido: esa diferencia permite enumerar la
      // base de usuarios probando correos.
      await expect(hasher.verifyDummy()).resolves.toBeUndefined();
      // La segunda llamada reutiliza el hash señuelo ya calculado.
      await expect(hasher.verifyDummy()).resolves.toBeUndefined();
    });

    it('el coste de verifyDummy es del mismo orden que una verificación real', async () => {
      const hash = await hasher.hash('ContrasenaSegura1');

      const measure = async (work: () => Promise<unknown>): Promise<number> => {
        const started = process.hrtime.bigint();
        await work();
        return Number(process.hrtime.bigint() - started) / 1e6;
      };

      await hasher.verifyDummy(); // calienta el hash señuelo
      const real = await measure(() => hasher.verify(hash, 'incorrecta'));
      const dummy = await measure(() => hasher.verifyDummy());

      // Margen amplio: la afirmación es "el mismo orden de magnitud", no una igualdad
      // exacta. Un umbral estrecho haría el test intermitente sin añadir garantía.
      expect(dummy).toBeGreaterThan(real / 10);
    });
  });
});
