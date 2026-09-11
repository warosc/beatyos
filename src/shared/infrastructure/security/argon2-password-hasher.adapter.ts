import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from '@node-rs/argon2';

import type { PasswordHasher } from '../../application/ports';
import type { Env } from '../config/env.schema';

/**
 * Identificador numérico de Argon2id.
 *
 * `@node-rs/argon2` lo publica como `const enum` ambiental, que TypeScript prohíbe leer
 * con `isolatedModules` activo —y `isolatedModules` hace falta para que ts-jest y ts-node
 * transpilen fichero a fichero, que es lo que mantiene rápida la suite—. Se declara aquí
 * el valor, una sola vez, y todo el proyecto lo importa de este punto en lugar de
 * repetir un `2` mágico.
 */
export const ARGON2ID = 2;

/**
 * Hashing de contraseñas con Argon2id (ADR-0005).
 *
 * Argon2id combina resistencia a ataques con GPU (por consumo de memoria) y a ataques
 * por canal lateral. Es lo que recomienda OWASP hoy, por delante de bcrypt —cuyo coste
 * en memoria es fijo y pequeño, justo la dimensión en la que una GPU es fuerte.
 *
 * Los parámetros van en el entorno para poder subirlos con el hardware sin tocar código
 * ni invalidar los hashes existentes: Argon2 los codifica dentro del propio hash, de
 * modo que las contraseñas antiguas siguen verificándose con sus parámetros originales
 * y se rehashean al siguiente inicio de sesión correcto.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly logger = new Logger(Argon2PasswordHasher.name);

  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  /**
   * Hash señuelo contra el que comparar cuando el correo no existe.
   *
   * Sin él, el login responde en microsegundos para un correo desconocido y en decenas
   * de milisegundos para uno conocido. Esa diferencia, medible desde fuera, convierte el
   * formulario de acceso en un oráculo que enumera la base de clientes (ADR-0005).
   *
   * Se calcula una vez al arrancar sobre una contraseña aleatoria que nadie conoce.
   */
  private dummyHash: string | null = null;
  private readonly dummySecret = Math.random().toString(36);

  constructor(config: ConfigService<Env, true>) {
    this.memoryCost = config.get('ARGON2_MEMORY_COST', { infer: true });
    this.timeCost = config.get('ARGON2_TIME_COST', { infer: true });
    this.parallelism = config.get('ARGON2_PARALLELISM', { infer: true });
  }

  async hash(plain: string): Promise<string> {
    this.assertUsable(plain);
    return hash(plain, {
      algorithm: ARGON2ID,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
    });
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain);
    } catch (error) {
      // Un hash corrupto o de otro algoritmo no es un fallo del sistema: es una
      // credencial que no valida. Se registra pero se responde como contraseña
      // incorrecta, sin dar pistas de qué ha pasado por dentro.
      this.logger.warn(`No se pudo verificar el hash: ${(error as Error).message}`);
      return false;
    }
  }

  async verifyDummy(): Promise<void> {
    this.dummyHash ??= await this.hash(this.dummySecret);
    await verify(this.dummyHash, 'contrasena-que-nunca-coincide').catch(() => false);
  }

  /**
   * `true` si el hash se creó con parámetros más flojos que los actuales.
   *
   * Permite endurecer los parámetros de forma progresiva: en cada inicio de sesión
   * correcto se rehashea la contraseña si hace falta, sin pedirle nada al usuario y sin
   * una migración masiva que dejaría a todo el mundo fuera.
   */
  needsRehash(hashed: string): boolean {
    const params = this.parseParameters(hashed);
    if (!params) return true;
    return params.m < this.memoryCost || params.t < this.timeCost || params.p < this.parallelism;
  }

  /** Formato PHC: `$argon2id$v=19$m=19456,t=2,p=1$<sal>$<hash>` */
  private parseParameters(hashed: string): { m: number; t: number; p: number } | null {
    const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashed);
    if (!match) return null;
    return { m: Number(match[1]), t: Number(match[2]), p: Number(match[3]) };
  }

  private assertUsable(plain: string): void {
    if (!plain) {
      throw new Error('No se puede hashear una contraseña vacía');
    }
    // Argon2 no tiene el límite de 72 bytes de bcrypt, pero una entrada sin tope permite
    // agotar CPU enviando megabytes en el campo de contraseña.
    if (Buffer.byteLength(plain, 'utf8') > 1024) {
      throw new Error('La contraseña excede el tamaño máximo admitido (1 KB)');
    }
  }
}
