/**
 * Identificación de imágenes por sus bytes iniciales (ADR-0016).
 *
 * **El tipo declarado por el cliente no vale nada.** La cabecera `Content-Type` y la
 * extensión del fichero las escribe quien sube, y ninguna de las dos se comprueba contra el
 * contenido. Alguien puede enviar un HTML con un `<script>` dentro llamándolo `foto.jpg` y
 * declarándolo `image/jpeg`; si después se sirve por una URL del almacén y el navegador lo
 * interpreta, es ejecución de código en el dominio que sirve esa URL.
 *
 * La única comprobación que no se puede falsear es mirar el contenido. Los formatos de
 * imagen empiezan por una firma fija —los «magic bytes»— y esta función la lee.
 *
 * No sustituye a las demás defensas: la URL se sirve con el tipo correcto y con
 * `Content-Disposition: attachment`, y el almacén está en su propio origen. Es la primera de
 * varias capas, no la única.
 */

export interface ImageSignature {
  readonly mimeType: string;
  /** Extensión canónica del formato. La del nombre original se ignora. */
  readonly extension: string;
}

/** Compara bytes en una posición concreta. `null` en un patrón significa «cualquiera». */
const matches = (buffer: Buffer, offset: number, pattern: readonly (number | null)[]): boolean => {
  if (buffer.length < offset + pattern.length) return false;

  return pattern.every((byte, index) => byte === null || buffer[offset + index] === byte);
};

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"
const FTYP = [0x66, 0x74, 0x79, 0x70] as const; // "ftyp"

/**
 * Marcas de HEIC/HEIF dentro de la caja `ftyp`.
 *
 * Es el formato por defecto de las fotos de iPhone, así que en un salón llega a diario. Se
 * admite en la subida y conviene convertirlo a JPEG antes de mostrarlo, porque los
 * navegadores de escritorio todavía no lo pintan.
 */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/**
 * Deduce el formato leyendo el principio del fichero.
 *
 * Devuelve `null` si no reconoce nada, y eso significa rechazar la subida: no reconocer un
 * formato es un motivo perfectamente bueno para no guardarlo, mientras que aceptarlo «por si
 * acaso» es como entra lo que no debería.
 */
export const detectImageSignature = (buffer: Buffer): ImageSignature | null => {
  if (matches(buffer, 0, JPEG)) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  if (matches(buffer, 0, PNG)) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  // WebP es un contenedor RIFF: "RIFF" + 4 bytes de tamaño + "WEBP".
  if (matches(buffer, 0, RIFF) && matches(buffer, 8, WEBP)) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  // HEIC/HEIF: caja `ftyp` en el desplazamiento 4, y la marca justo después.
  if (matches(buffer, 4, FTYP) && buffer.length >= 12) {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (HEIF_BRANDS.has(brand)) {
      return { mimeType: 'image/heic', extension: 'heic' };
    }
  }

  return null;
};

/** Bytes que hay que leer para identificar cualquiera de los formatos admitidos. */
export const SIGNATURE_BYTES_NEEDED = 12;

/**
 * Dimensiones de la imagen, cuando se pueden leer de la cabecera.
 *
 * Solo se intenta con PNG y JPEG, que las llevan cerca del principio y se sacan sin
 * decodificar. Devolver `null` es aceptable: las dimensiones sirven para maquetar la galería
 * sin saltos, no para ninguna regla de negocio, y no merecen arrastrar una dependencia de
 * procesado de imagen para los formatos que las esconden.
 */
export const readImageDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  if (matches(buffer, 0, PNG) && buffer.length >= 24) {
    // La cabecera IHDR va inmediatamente después de la firma: ancho y alto, 4 bytes cada uno.
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (matches(buffer, 0, JPEG)) {
    return readJpegDimensions(buffer);
  }

  return null;
};

/**
 * Recorre los segmentos JPEG hasta el marcador que declara el tamaño.
 *
 * Un JPEG es una cadena de segmentos con su longitud, así que hay que saltar de uno a otro
 * hasta encontrar un `SOF` (Start Of Frame). El bucle está acotado por la longitud del
 * fichero **y** por un tope de iteraciones: un fichero corrupto —o construido a mala fe—
 * puede declarar longitudes que hagan girar el puntero sin avanzar nunca.
 */
const readJpegDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  let offset = 2;

  // `offset + 9 <= length`, no `<`: leer el ancho toca los bytes `offset + 7` y
  // `offset + 8`, asi que hacen falta nueve bytes contando desde `offset`. Con `<` se
  // perdian las dimensiones de un JPEG cuyo marcador termina justo al final del fichero.
  for (let guard = 0; guard < 1024 && offset + 9 <= buffer.length; guard += 1) {
    if (buffer[offset] !== 0xff) return null;

    const marker = buffer[offset + 1];

    // SOF0..SOF15, excluyendo DHT (c4), JPG (c8) y DAC (cc), que no describen el fotograma.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    // Un segmento declara al menos sus dos bytes de longitud. Menos que eso no avanzaría.
    if (segmentLength < 2) return null;

    offset += 2 + segmentLength;
  }

  return null;
};
