import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Booleano que llega como texto, en una query o en un formulario multipart.
 *
 * Existe porque `@Type(() => Boolean)` **es incorrecto para cadenas** y de una forma que
 * pasa desapercibida: `Boolean('false')` es `true`, igual que `Boolean('0')` y
 * `Boolean('no')`. Todo lo que no sea la cadena vacía se convierte en `true`.
 *
 * El fallo no es teórico. Con `@Type(() => Boolean)`, un formulario que enviara
 * `allowsMarketing=false` concedía permiso para publicar la foto de una clienta que
 * explícitamente lo había denegado, y un filtro `?onlyAvailable=false` filtraba justo al
 * revés de lo pedido. En los dos casos el sistema hacía lo contrario de lo que se le decía,
 * sin error ni aviso.
 *
 * Aquí la conversión es **explícita y por lista blanca**: solo `true` y `1` son verdadero,
 * y lo demás es falso. Un valor que no se reconoce no se interpreta a la ligera.
 */
export const BooleanParam = (): PropertyDecorator =>
  applyDecorators(
    IsOptional(),
    Transform(({ value }) => {
      if (typeof value === 'boolean') return value;
      if (value === undefined || value === null || value === '') return undefined;

      const normalized = String(value).trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;

      // Se devuelve tal cual para que `@IsBoolean()` lo rechace con un mensaje claro.
      // Convertirlo a `false` en silencio escondería un error de quien llama.
      return value as unknown;
    }),
    IsBoolean(),
  );
