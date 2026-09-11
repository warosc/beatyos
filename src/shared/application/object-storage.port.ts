/**
 * Almacén de objetos (ADR-0016).
 *
 * El puerto no menciona MinIO, ni S3, ni buckets: habla de claves y contenidos. Detrás hay
 * MinIO en desarrollo y puede haber S3, R2 o Spaces en producción, y ese cambio no debería
 * llegar a la capa de aplicación.
 *
 * Es un puerto **compartido** y no del módulo de clientes a propósito. Las fotos de clienta
 * son el primer uso, pero el avatar del profesional, la imagen de un producto y el PDF de
 * una factura son el mismo problema; tenerlo aquí es lo que evita que el segundo caso traiga
 * consigo una segunda implementación (ADR-0002).
 */

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  /** SHA-256 del contenido, en hexadecimal. */
  readonly checksum: string;
}

export interface PutObjectParams {
  readonly key: string;
  readonly body: Buffer;
  /**
   * Tipo con el que el almacén servirá el objeto.
   *
   * Lo fija la aplicación tras identificar el fichero por sus bytes, **nunca** el cliente:
   * es lo que decide cómo lo interpreta el navegador que abra la URL.
   */
  readonly contentType: string;
  /** Nombre con el que se ofrecerá al descargar. Solo para presentación. */
  readonly downloadName?: string;
}

export interface ObjectStorage {
  put(params: PutObjectParams): Promise<StoredObject>;

  /**
   * URL temporal para leer el objeto.
   *
   * Se firma por petición y caduca pronto. La alternativa —hacer el bucket público— pondría
   * las fotos de las clientas a un `curl` de distancia para cualquiera que adivinara una
   * ruta, y las rutas no son secretas.
   *
   * Quien pide la URL ya ha pasado por el guard de permisos: la firma no autoriza, solo
   * transporta una autorización que ya se concedió.
   */
  presignedGetUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Borra el objeto. Idempotente: borrar lo que ya no está no es un error. */
  remove(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;
}

export const OBJECT_STORAGE = Symbol('ObjectStorage');
