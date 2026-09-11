import { createHash } from 'node:crypto';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';

import type {
  ObjectStorage,
  PutObjectParams,
  StoredObject,
} from '../../application/object-storage.port';
import type { Env } from '../config/env.schema';

/**
 * Adaptador de almacenamiento sobre MinIO (ADR-0016).
 *
 * MinIO habla el protocolo de S3, así que este mismo adaptador vale contra S3, R2 o Spaces
 * cambiando las variables de entorno. Es la razón de haber elegido MinIO en desarrollo en
 * lugar de escribir en disco: el código que se prueba en local es el que corre en
 * producción, no un primo suyo.
 */
@Injectable()
export class MinioObjectStorage implements ObjectStorage, OnModuleInit {
  private readonly logger = new Logger(MinioObjectStorage.name);
  private readonly client: MinioClient;
  private readonly bucket: string;
  private readonly region: string;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.region = config.get('S3_REGION', { infer: true });

    this.client = new MinioClient({
      endPoint: config.get('S3_ENDPOINT', { infer: true }),
      port: config.get('S3_PORT', { infer: true }),
      useSSL: config.get('S3_USE_SSL', { infer: true }),
      accessKey: config.get('S3_ACCESS_KEY', { infer: true }),
      secretKey: config.get('S3_SECRET_KEY', { infer: true }),
      region: this.region,
    });
  }

  /**
   * Crea el bucket si falta.
   *
   * Al arrancar y no en la primera subida: un fallo de configuración del almacén debe
   * aparecer cuando se levanta el servicio, no la primera vez que alguien intenta guardar
   * una foto un sábado por la tarde.
   *
   * No se hace fatal a propósito. El almacén es una dependencia de una funcionalidad, no del
   * sistema entero: que MinIO esté caído no debería impedir cobrar ni dar cita, y tumbar el
   * arranque por eso convertiría un problema de fotos en una caída completa.
   */
  async onModuleInit(): Promise<void> {
    try {
      if (!(await this.client.bucketExists(this.bucket))) {
        await this.client.makeBucket(this.bucket, this.region);
        this.logger.log(`Bucket "${this.bucket}" creado en el almacén de objetos`);
      }
    } catch (error) {
      this.logger.error(
        `No se pudo preparar el bucket "${this.bucket}". Las fotos no funcionarán hasta ` +
          `que el almacén responda: ${(error as Error).message}`,
      );
    }
  }

  async put(params: PutObjectParams): Promise<StoredObject> {
    const checksum = createHash('sha256').update(params.body).digest('hex');

    await this.client.putObject(this.bucket, params.key, params.body, params.body.length, {
      'Content-Type': params.contentType,
      // `attachment` y no `inline`: aunque el tipo ya se ha verificado leyendo los bytes,
      // forzar la descarga cierra la puerta a que el navegador interprete el contenido si
      // alguna vez se colara algo. Es una segunda capa, y las capas se ponen antes de
      // necesitarlas.
      'Content-Disposition': params.downloadName
        ? `attachment; filename="${sanitizeFilename(params.downloadName)}"`
        : 'attachment',
      // Evita que un proxy intente adivinar el tipo por su cuenta e ignore el declarado.
      'X-Content-Type-Options': 'nosniff',
      'x-amz-meta-checksum-sha256': checksum,
    });

    return { key: params.key, sizeBytes: params.body.length, checksum };
  }

  presignedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedGetObject(this.bucket, key, ttlSeconds);
  }

  /** Idempotente: borrar lo que ya no está no es un error que haya que propagar. */
  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Limpia el nombre que se ofrecerá al descargar.
 *
 * Va dentro de una cabecera HTTP entre comillas. Sin limpiar, unas comillas o un salto de
 * línea en el nombre del fichero permitirían inyectar cabeceras adicionales en la respuesta
 * del almacén. Se conservan letras, dígitos y unos pocos separadores, que es todo lo que un
 * nombre de fichero necesita para seguir siendo legible.
 */
const sanitizeFilename = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120);
