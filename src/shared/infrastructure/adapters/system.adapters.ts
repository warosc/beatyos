import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { Clock, IdGenerator } from '../../application/ports';

/**
 * Adaptadores para las dos fuentes de indeterminismo del sistema.
 *
 * Están detrás de un puerto porque son exactamente lo que hace que un test pase el
 * lunes y falle el domingo, o que "la cita se agenda para mañana" deje de cumplirse a
 * las 23:59. En los tests se sustituyen por implementaciones fijas y el resultado deja
 * de depender de cuándo se ejecute la suite.
 */

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Reloj congelado para tests. Vive junto al real a propósito: separarlos invita a que
 * uno evolucione sin el otro.
 */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  /** Avanza el reloj. Permite probar caducidades sin esperar de verdad. */
  advanceBy(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  setTo(instant: Date): void {
    this.current = new Date(instant);
  }
}

/**
 * Generador de UUIDv7.
 *
 * `crypto.randomUUID()` produce v4, cuyos bits son puro azar. Como clave primaria eso
 * significa que cada inserción cae en una página aleatoria del índice B-tree: el índice
 * se fragmenta, la caché de páginas deja de servir y el rendimiento de escritura se
 * degrada según crece la tabla.
 *
 * UUIDv7 antepone 48 bits de marca temporal en milisegundos, de modo que los
 * identificadores se generan casi ordenados y las inserciones van al final del índice,
 * como una clave autoincremental. Conserva la ventaja de v4 —se puede generar en la
 * aplicación sin ir a la base de datos, y no revela cuántos registros hay— sin pagar su
 * coste. En `inventory_movements` y `audit_logs`, que crecen sin parar, la diferencia es
 * medible.
 *
 * Como efecto colateral útil, ordenar por `id` ordena aproximadamente por antigüedad.
 */
@Injectable()
export class UuidV7Generator implements IdGenerator {
  /** Última marca temporal usada, para mantener el orden dentro del mismo milisegundo. */
  private lastTimestamp = 0;
  private sequence = 0;

  generate(): string {
    const bytes = randomBytes(16);
    let timestamp = Date.now();

    // Dentro de un mismo milisegundo, un contador en los 12 bits de `rand_a` mantiene
    // el orden entre identificadores. Sin esto, dos filas creadas en el mismo instante
    // podrían ordenarse al revés de como se crearon —irrelevante para la corrección,
    // molesto en un listado cronológico.
    if (timestamp === this.lastTimestamp) {
      this.sequence += 1;
      if (this.sequence > 0x0fff) {
        // Contador desbordado: se avanza al milisegundo siguiente en lugar de repetir.
        timestamp += 1;
        this.lastTimestamp = timestamp;
        this.sequence = 0;
      }
    } else {
      this.lastTimestamp = timestamp;
      this.sequence = 0;
    }

    const ts = BigInt(timestamp);
    bytes[0] = Number((ts >> 40n) & 0xffn);
    bytes[1] = Number((ts >> 32n) & 0xffn);
    bytes[2] = Number((ts >> 24n) & 0xffn);
    bytes[3] = Number((ts >> 16n) & 0xffn);
    bytes[4] = Number((ts >> 8n) & 0xffn);
    bytes[5] = Number(ts & 0xffn);

    // Versión 7 en el nibble alto del byte 6, y el contador en los 12 bits restantes.
    bytes[6] = 0x70 | ((this.sequence >> 8) & 0x0f);
    bytes[7] = this.sequence & 0xff;

    // Variante RFC 4122 (10xx) en los dos bits altos del byte 8.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }
}

/** Generador determinista para tests: los identificadores dejan de ser ruido. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = '00000000-0000-7000-8000') {}

  generate(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter.toString(16).padStart(12, '0')}`;
  }
}
