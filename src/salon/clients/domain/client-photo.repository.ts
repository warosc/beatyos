import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { ClientPhoto, ClientPhotoKindValue } from './client-photo.entity';

export interface ClientPhotoFilter {
  readonly clientId?: string;
  readonly appointmentId?: string;
  readonly serviceId?: string;
  readonly kind?: ClientPhotoKindValue;
  readonly from?: Date;
  readonly to?: Date;
  /** Solo las que la clienta autorizó publicar. Es la consulta del portfolio. */
  readonly onlyPublishable?: boolean;
}

export type ClientPhotoSortField = 'takenAt' | 'createdAt';

export interface ClientPhotoRepository extends SearchableRepository<
  ClientPhoto,
  ClientPhotoFilter,
  ClientPhotoSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<ClientPhoto>;

  /**
   * Foto con el mismo contenido para esa clienta, si ya existe.
   *
   * Se busca por huella SHA-256 y no por nombre. Subir dos veces la misma foto es corriente
   * —la encargada no recuerda si ya lo hizo— y guardar el fichero por duplicado gasta
   * espacio y ensucia la galería con dos entradas idénticas que nadie sabe cuál borrar.
   */
  findByChecksum(clientId: string, checksum: string): Promise<ClientPhoto | null>;

  create(photo: ClientPhoto): Promise<ClientPhoto>;
  update(photo: ClientPhoto): Promise<ClientPhoto>;

  search(
    filter: ClientPhotoFilter,
    page: PageRequest<ClientPhotoSortField>,
    options?: QueryOptions,
  ): Promise<Page<ClientPhoto>>;

  /**
   * Fotos dadas de baja hace más de `days` días cuyo fichero sigue en el almacén.
   *
   * La alimenta el proceso de purga. La ventana existe para que una baja por error se pueda
   * deshacer: entre dar de baja y borrar el fichero de verdad tiene que haber margen, porque
   * lo segundo no tiene vuelta atrás.
   */
  findPurgeable(days: number, now: Date, limit: number): Promise<ClientPhoto[]>;
}

export const CLIENT_PHOTO_REPOSITORY = Symbol('ClientPhotoRepository');
