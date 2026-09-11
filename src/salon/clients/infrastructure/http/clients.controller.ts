import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ConfigService } from '@nestjs/config';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import { CLOCK, type AccessTokenClaims, type Clock } from '../../../../shared/application/ports';
import { Inject } from '@nestjs/common';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import {
  AnonymizeClientUseCase,
  CreateClientUseCase,
  DeleteClientUseCase,
  GetClientUseCase,
  RestoreClientUseCase,
  SearchClientsUseCase,
  UpdateClientUseCase,
} from '../../application/client.use-cases';
import type { ClientSortField } from '../../domain/client.repository';
import {
  AnonymizeClientDto,
  ClientQueryDto,
  ClientResponse,
  CreateClientDto,
  UpdateClientDto,
} from './client.dto';

/**
 * Adaptador HTTP de clientas.
 *
 * Cada endpoint declara su permiso (ADR-0006). El guard es global y **deniega por
 * defecto**: si alguien añade un método sin `@RequirePermissions`, el endpoint queda
 * cerrado y el log lo señala, en lugar de quedar abierto sin que nadie lo note.
 *
 * El `tenantId` no aparece por ninguna parte: lo aporta el token y lo aplica la extensión
 * de Prisma (ADR-0003). Que no se pueda escribir aquí es justamente lo que impide que
 * alguien lo tome del cuerpo de la petición.
 */
@ApiTags('Clientas')
@Controller({ path: 'clients', version: '1' })
export class ClientsController {
  private readonly defaultCurrency: string;

  constructor(
    private readonly createClient: CreateClientUseCase,
    private readonly updateClient: UpdateClientUseCase,
    private readonly getClient: GetClientUseCase,
    private readonly searchClients: SearchClientsUseCase,
    private readonly deleteClient: DeleteClientUseCase,
    private readonly restoreClient: RestoreClientUseCase,
    private readonly anonymizeClient: AnonymizeClientUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.defaultCurrency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Post()
  @RequirePermissions(PERMISSIONS.clients.create)
  @ApiOperation({
    summary: 'Dar de alta una clienta',
    description:
      'Exige al menos un correo o un teléfono: sin vía de contacto no se puede avisar de ' +
      'un cambio de cita, que es el uso más frecuente de la ficha.',
  })
  @ApiCreatedResponse({ type: ClientResponse })
  @ApiConflictResponse({
    description:
      'Ya existe una clienta con ese correo. Si la coincidencia es con una ficha eliminada, ' +
      'el código será `CLIENT_EXISTS_DELETED` y procede recuperarla en lugar de crear otra.',
  })
  async create(
    @Body() dto: CreateClientDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ClientResponse> {
    const client = await this.createClient.execute({
      ...dto,
      // El salón sale del token, nunca del cuerpo de la petición.
      tenantId: user.tenantId!,
      currency: this.defaultCurrency,
      actorId: user.sub,
    });
    return ClientResponse.from(client, this.clock.now());
  }

  @Get()
  @RequirePermissions(PERMISSIONS.clients.read)
  @ApiOperation({
    summary: 'Listar clientas',
    description:
      'Paginado, ordenable y filtrable. Campos de orden admitidos: `name`, `createdAt`, ' +
      '`lastVisitAt`, `totalSpent`, `totalVisits`, `loyaltyPoints`.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/ClientResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: ClientQueryDto,
  ): Promise<{ data: ClientResponse[]; meta: PageMetaResponse }> {
    const now = this.clock.now();

    const page = await this.searchClients.execute({
      filter: {
        search: query.search,
        status: query.status,
        marketingConsent: query.marketingConsent,
        city: query.city,
        inactiveSince: query.inactiveSince,
        birthdayWithinDays: query.birthdayWithinDays,
      },
      page: query.toPageRequest<ClientSortField>(),
      includeDeleted: query.includeDeleted,
    });

    // El filtro de cumpleaños se resuelve en memoria sobre la página ya traída: en SQL
    // exigiría comparar día y mes ignorando el año, que en PostgreSQL no aprovecha un
    // índice B-tree normal. Con volúmenes de salón (miles de fichas, no millones) es
    // preferible esto a añadir una columna calculada y su índice para un uso ocasional.
    const data = page.data
      .filter(
        (client) =>
          query.birthdayWithinDays === undefined ||
          client.hasBirthdayWithin(query.birthdayWithinDays, now),
      )
      .map((client) => ClientResponse.from(client, now));

    return { data, meta: page.meta };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.clients.read)
  @ApiOperation({ summary: 'Consultar una clienta' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ClientResponse })
  @ApiNotFoundResponse({
    description:
      'No existe, o pertenece a otro salón. Se devuelve 404 y no 403 en ambos casos: un ' +
      '403 confirmaría que el recurso existe (ADR-0003).',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ClientResponse> {
    return ClientResponse.from(await this.getClient.execute(id), this.clock.now());
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.clients.update)
  @ApiOperation({
    summary: 'Modificar una clienta',
    description: 'Actualización parcial. Envíe `null` en un campo opcional para vaciarlo.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ClientResponse })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ClientResponse> {
    const client = await this.updateClient.execute({ ...dto, id, actorId: user.sub });
    return ClientResponse.from(client, this.clock.now());
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.clients.delete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dar de baja una clienta',
    description:
      'Borrado lógico: la ficha desaparece de los listados pero su historial de citas y ' +
      'facturas sigue siendo consultable y contablemente válido. Es reversible con ' +
      '`POST /clients/{id}/restore`. Para el borrado real de datos personales use ' +
      '`POST /clients/{id}/anonymize`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.deleteClient.execute({ id, actorId: user.sub });
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.clients.restore)
  @ApiOperation({ summary: 'Recuperar una clienta dada de baja' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ClientResponse })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ClientResponse> {
    const client = await this.restoreClient.execute({ id, actorId: user.sub });
    return ClientResponse.from(client, this.clock.now());
  }

  @Post(':id/anonymize')
  @RequirePermissions(PERMISSIONS.clients.anonymize)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Anonimizar una clienta (derecho de supresión, RGPD)',
    description:
      '**Irreversible.** Sobrescribe los datos personales —nombre, contacto, dirección, ' +
      'alergias— y conserva la fila con un identificador seudónimo, de modo que las ' +
      'facturas emitidas sigan siendo válidas para la obligación fiscal de conservación. ' +
      'Requiere permiso propio, distinto del de dar de baja, y queda registrado en la ' +
      'auditoría con el motivo indicado.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  async anonymize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnonymizeClientDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.anonymizeClient.execute({ id, reason: dto.reason, actorId: user.sub });
  }
}
