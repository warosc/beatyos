import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ClientPhotoKind, PhotoConsentSource } from '@prisma/client';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { BusinessRuleViolationError, ForbiddenActionError } from '../../../../shared/domain/errors';
import { BooleanParam } from '../../../../shared/infrastructure/http/boolean-param.decorator';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  DeleteClientPhotoUseCase,
  DescribeClientPhotoUseCase,
  PurgeDeletedPhotosUseCase,
  SearchClientPhotosUseCase,
  UploadClientPhotoUseCase,
  type PhotoWithUrl,
} from '../../application/client-photo.use-cases';
import type { ClientPhoto } from '../../domain/client-photo.entity';

/**
 * Fotos del historial de una clienta (ADR-0016).
 *
 * La subida es multipart y el fichero llega **en memoria**, no a disco. Un temporal en disco
 * exige limpiarlo aunque la petición falle a mitad, y una foto de un salón cabe holgadamente
 * en memoria; el tope lo impone `PHOTO_MAX_BYTES` antes de que el caso de uso la mire.
 */

export class UploadPhotoDto {
  @ApiProperty({
    description: 'Momento en que la clienta autorizó guardar su imagen. Sin esto no se sube',
    example: '2026-09-03T10:00:00.000Z',
  })
  @IsISO8601()
  consentGivenAt!: string;

  @ApiPropertyOptional({ enum: PhotoConsentSource, default: 'IN_PERSON' })
  @IsOptional()
  @IsEnum(PhotoConsentSource)
  consentSource?: PhotoConsentSource;

  @ApiPropertyOptional({
    default: false,
    description: 'Autoriza además publicarla. Es una decisión distinta de la de guardarla',
  })
  @BooleanParam()
  allowsMarketing?: boolean;

  @ApiPropertyOptional({ enum: ClientPhotoKind, default: 'OTHER' })
  @IsOptional()
  @IsEnum(ClientPhotoKind)
  kind?: ClientPhotoKind;

  @ApiPropertyOptional() @IsOptional() @IsUUID() appointmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(250) caption?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() takenAt?: string;
}

export class DescribePhotoDto {
  @ApiPropertyOptional({ enum: ClientPhotoKind })
  @IsOptional()
  @IsEnum(ClientPhotoKind)
  kind?: ClientPhotoKind;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(250) caption?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() appointmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceId?: string;

  @ApiPropertyOptional({ description: 'Se puede retirar en cualquier momento' })
  @IsOptional()
  @IsBoolean()
  allowsMarketing?: boolean;
}

/**
 * Parametros de la purga.
 *
 * Existe como DTO y no como un `@Body()` sin tipar porque un cuerpo sin clase **se salta la
 * validacion entera**: `ValidationPipe` no valida lo que no tiene metatipo, de modo que ni
 * se comprueban los valores ni se transforman. Ademas de dejar pasar cualquier cosa, hacia
 * que `olderThanDays: 0` no llegara al caso de uso y la purga usara siempre su valor por
 * defecto de treinta dias.
 */
export class PurgePhotosDto {
  @ApiPropertyOptional({
    default: 30,
    description: 'Ventana de gracia. Cero purga todo lo dado de baja, sin margen para deshacer',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  olderThanDays?: number;

  @ApiPropertyOptional({ default: 100, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class PhotoQueryDto {
  @ApiPropertyOptional({ enum: ClientPhotoKind })
  @IsOptional()
  @IsEnum(ClientPhotoKind)
  kind?: ClientPhotoKind;

  @ApiPropertyOptional() @IsOptional() @IsUUID() appointmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ---------------------------------------------------------------------------

@ApiTags('Fotos de clienta')
@Controller({ path: 'clients/:clientId/photos', version: '1' })
export class ClientPhotosController {
  constructor(
    private readonly uploadPhoto: UploadClientPhotoUseCase,
    private readonly searchPhotos: SearchClientPhotosUseCase,
    private readonly describePhoto: DescribeClientPhotoUseCase,
    private readonly deletePhoto: DeleteClientPhotoUseCase,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.clients.read)
  @ApiOperation({ summary: 'Galería de la clienta, con URL temporales ya firmadas' })
  async list(@Param('clientId', ParseUUIDPipe) clientId: string, @Query() query: PhotoQueryDto) {
    const page = await this.searchPhotos.execute({
      filter: {
        clientId,
        kind: query.kind,
        appointmentId: query.appointmentId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? 50 },
    });

    return { data: page.data.map(presentPhotoWithUrl), meta: page.meta };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.clients.update)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'consentGivenAt'],
      properties: {
        file: { type: 'string', format: 'binary' },
        consentGivenAt: { type: 'string', format: 'date-time' },
        consentSource: { type: 'string', enum: Object.values(PhotoConsentSource) },
        allowsMarketing: { type: 'boolean' },
        kind: { type: 'string', enum: Object.values(ClientPhotoKind) },
        appointmentId: { type: 'string', format: 'uuid' },
        serviceId: { type: 'string', format: 'uuid' },
        caption: { type: 'string' },
        notes: { type: 'string' },
        takenAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiOperation({
    summary: 'Sube una foto. El tipo se deduce del contenido, no de lo que declare el cliente',
  })
  async upload(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadPhotoDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    if (!file?.buffer?.length) {
      throw new BusinessRuleViolationError('FILE_REQUIRED', 'Adjunte la foto en el campo «file»');
    }

    const result = await this.uploadPhoto.execute({
      tenantId: requireTenant(user),
      clientId,
      content: file.buffer,
      originalName: file.originalname ?? null,
      kind: dto.kind,
      appointmentId: dto.appointmentId ?? null,
      serviceId: dto.serviceId ?? null,
      caption: dto.caption ?? null,
      notes: dto.notes ?? null,
      takenAt: dto.takenAt ? new Date(dto.takenAt) : null,
      consentGivenAt: new Date(dto.consentGivenAt),
      consentSource: dto.consentSource,
      allowsMarketing: dto.allowsMarketing,
      actorId: user.sub,
    });

    // `deduplicated` se informa en lugar de ocultarse: quien sube dos veces la misma foto
    // debe saber que no ha creado una entrada nueva, o volverá a intentarlo.
    return { ...presentPhoto(result.photo), deduplicated: result.deduplicated };
  }

  @Patch(':photoId')
  @RequirePermissions(PERMISSIONS.clients.update)
  @ApiOperation({ summary: 'Corrige los datos de la foto. El fichero no se puede sustituir' })
  async describe(
    @Param('clientId', ParseUUIDPipe) _clientId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Body() dto: DescribePhotoDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const photo = await this.describePhoto.execute({
      photoId,
      kind: dto.kind,
      caption: dto.caption,
      notes: dto.notes,
      appointmentId: dto.appointmentId,
      serviceId: dto.serviceId,
      allowsMarketing: dto.allowsMarketing,
      actorId: user.sub,
    });

    return presentPhoto(photo);
  }

  @Delete(':photoId')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.clients.update)
  @ApiOperation({
    summary: 'Da de baja la foto. El fichero se borra del almacén en la purga posterior',
  })
  async remove(
    @Param('clientId', ParseUUIDPipe) _clientId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.deletePhoto.execute({ photoId, actorId: user.sub });
  }
}

// ---------------------------------------------------------------------------

/**
 * Purga de ficheros.
 *
 * Vive fuera del recurso de una clienta porque no es una operación sobre una clienta: es
 * mantenimiento del almacén. Exige `clients.anonymize`, que es el permiso de borrado
 * definitivo de datos personales y no el de editar una ficha.
 */
@ApiTags('Fotos de clienta')
@Controller({ path: 'photos', version: '1' })
export class PhotoMaintenanceController {
  constructor(private readonly purge: PurgeDeletedPhotosUseCase) {}

  @Post('purge')
  @RequirePermissions(PERMISSIONS.clients.anonymize)
  @ApiOperation({
    summary: 'Borra del almacén los ficheros de las fotos dadas de baja hace más de N días',
  })
  async run(@Body() dto: PurgePhotosDto) {
    return this.purge.execute({ olderThanDays: dto.olderThanDays, limit: dto.limit });
  }
}

// ---------------------------------------------------------------------------

/**
 * Foto serializada.
 *
 * **No incluye `storageKey`.** La ruta interna del objeto no le sirve de nada al cliente y
 * revela cómo está organizado el almacén; lo que necesita es la URL firmada, que ya se le
 * entrega y caduca sola.
 */
const presentPhoto = (photo: ClientPhoto) => ({
  id: photo.id,
  clientId: photo.clientId,
  appointmentId: photo.appointmentId,
  serviceId: photo.serviceId,
  kind: photo.kind,
  mimeType: photo.mimeType,
  sizeBytes: photo.sizeBytes,
  width: photo.width,
  height: photo.height,
  originalName: photo.originalName,
  caption: photo.caption,
  notes: photo.notes,
  takenAt: photo.takenAt,
  consent: {
    givenAt: photo.consent.givenAt,
    source: photo.consent.source,
    allowsMarketing: photo.consent.allowsMarketing,
  },
  isPublishable: photo.isPublishable,
  createdAt: photo.audit.createdAt,
});

const presentPhotoWithUrl = (item: PhotoWithUrl) => ({
  ...presentPhoto(item.photo),
  url: item.url,
  urlExpiresAt: item.expiresAt,
});

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError(
      'clients.photos.upload',
      'Subir fotos requiere estar asignado a un salón',
    );
  }
  return user.tenantId;
};
