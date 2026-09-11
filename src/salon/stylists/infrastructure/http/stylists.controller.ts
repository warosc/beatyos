import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { parseMinutes } from '../../../../shared/domain/time/zoned-time';
import {
  Authenticated,
  CurrentUser,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import {
  AddTimeOffUseCase,
  CreateStylistUseCase,
  DeleteStylistUseCase,
  GetStylistUseCase,
  GetStylistWorkingHoursUseCase,
  RemoveTimeOffUseCase,
  RestoreStylistUseCase,
  SearchStylistsUseCase,
  SetStylistScheduleUseCase,
  SetStylistSkillsUseCase,
  UpdateStylistUseCase,
} from '../../application/stylist.use-cases';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
  type StylistSortField,
} from '../../domain/stylist.repository';
import {
  AddTimeOffDto,
  CreateStylistDto,
  SetScheduleDto,
  SetSkillsDto,
  StylistQueryDto,
  StylistResponse,
  UpdateStylistDto,
  WorkingHoursQueryDto,
  WorkingHoursResponse,
} from './stylist.dto';

/**
 * Adaptador HTTP de profesionales.
 *
 * Horario, ausencias y habilidades tienen endpoints propios en lugar de ser campos del
 * `PATCH` general. Es deliberado: cada uno se edita en una pantalla distinta, tiene su
 * propio permiso (`stylists.manage-schedule`) y sus propias reglas. Meterlos en el
 * `PATCH` obligaría a enviar el agregado entero para cambiar una ausencia.
 */
@ApiTags('Profesionales')
@Controller({ path: 'stylists', version: '1' })
export class StylistsController {
  constructor(
    private readonly createStylist: CreateStylistUseCase,
    private readonly updateStylist: UpdateStylistUseCase,
    private readonly getStylist: GetStylistUseCase,
    private readonly searchStylists: SearchStylistsUseCase,
    private readonly deleteStylist: DeleteStylistUseCase,
    private readonly restoreStylist: RestoreStylistUseCase,
    private readonly setSchedule: SetStylistScheduleUseCase,
    private readonly addTimeOff: AddTimeOffUseCase,
    private readonly removeTimeOff: RemoveTimeOffUseCase,
    private readonly setSkills: SetStylistSkillsUseCase,
    private readonly workingHours: GetStylistWorkingHoursUseCase,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.stylists.create)
  @ApiOperation({ summary: 'Dar de alta un profesional' })
  @ApiCreatedResponse({ type: StylistResponse })
  async create(
    @Body() dto: CreateStylistDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.createStylist.execute({
      ...dto,
      tenantId: user.tenantId!,
      actorId: user.sub,
    });
    return StylistResponse.from(stylist);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.stylists.read)
  @ApiOperation({
    summary: 'Listar profesionales',
    description:
      'Filtre por `canPerformServiceId` para obtener quiénes pueden atender un servicio: es ' +
      'la consulta que alimenta el selector de la pantalla de reserva.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/StylistResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: StylistQueryDto,
  ): Promise<{ data: StylistResponse[]; meta: PageMetaResponse }> {
    const page = await this.searchStylists.execute({
      filter: {
        search: query.search,
        status: query.status,
        canPerformServiceId: query.canPerformServiceId,
        onlyBookable: query.onlyBookable,
      },
      page: query.toPageRequest<StylistSortField>(),
      includeDeleted: query.includeDeleted,
    });

    return { data: page.data.map((stylist) => StylistResponse.from(stylist)), meta: page.meta };
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({
    summary: 'Ficha profesional de quien ha iniciado sesión',
    description:
      'Devuelve `null` si la cuenta no tiene ficha de profesional vinculada. No exige ' +
      '`stylists.read`: cada quien puede consultar la suya propia, igual que `/auth/me`.',
  })
  @ApiOkResponse({ type: StylistResponse })
  async me(@CurrentUser() user: AccessTokenClaims): Promise<StylistResponse | null> {
    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist ? StylistResponse.from(stylist) : null;
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.stylists.read)
  @ApiOperation({ summary: 'Consultar un profesional con su horario y habilidades' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  @ApiNotFoundResponse({ description: 'No existe o pertenece a otro salón' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<StylistResponse> {
    return StylistResponse.from(await this.getStylist.execute(id));
  }

  @Get(':id/working-hours')
  @RequirePermissions(PERMISSIONS.stylists.read)
  @ApiOperation({
    summary: 'Horario trabajable en un rango de días',
    description:
      'Devuelve los tramos de trabajo ya descontadas las ausencias, como instantes absolutos. ' +
      '**No descuenta las citas**: esto es capacidad, no disponibilidad. Para los huecos ' +
      'libres reales, use la agenda.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [WorkingHoursResponse] })
  async getWorkingHours(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WorkingHoursQueryDto,
  ): Promise<WorkingHoursResponse[]> {
    return this.workingHours.execute({ stylistId: id, from: query.from, to: query.to });
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.stylists.update)
  @ApiOperation({ summary: 'Modificar la ficha de un profesional' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStylistDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.updateStylist.execute({ ...dto, id, actorId: user.sub });
    return StylistResponse.from(stylist);
  }

  @Put(':id/schedule')
  @RequirePermissions(PERMISSIONS.stylists.manageSchedule)
  @ApiOperation({
    summary: 'Fijar el horario semanal',
    description:
      '`PUT` y no `PATCH` porque **reemplaza** el horario completo. Un horario es una unidad ' +
      'con sentido —«mi semana»— y editarlo tramo a tramo abre estados intermedios ' +
      'incoherentes. Las horas van en formato local del salón (`HH:MM`).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  @ApiUnprocessableEntityResponse({ description: 'Los tramos de un mismo día se solapan' })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetScheduleDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.setSchedule.execute({
      stylistId: id,
      // La traducción de `"09:00"` a minutos ocurre en el borde: el dominio trabaja con
      // números y no tiene por qué conocer el formato de la API.
      blocks: dto.blocks.map((block) => ({
        dayOfWeek: block.dayOfWeek,
        startMinutes: parseMinutes(block.start),
        endMinutes: parseMinutes(block.end),
      })),
      actorId: user.sub,
    });

    return StylistResponse.from(stylist);
  }

  @Post(':id/time-off')
  @RequirePermissions(PERMISSIONS.stylists.manageSchedule)
  @ApiOperation({
    summary: 'Registrar una ausencia',
    description:
      'Vacaciones, formación o baja. Bloquea la agenda por completo mientras dura y recorta ' +
      'los tramos de trabajo que solape.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: StylistResponse })
  @ApiUnprocessableEntityResponse({ description: 'Ya hay una ausencia que se solapa' })
  async createTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTimeOffDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.addTimeOff.execute({
      stylistId: id,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      reason: dto.reason,
      actorId: user.sub,
    });
    return StylistResponse.from(stylist);
  }

  @Delete(':id/time-off/:timeOffId')
  @RequirePermissions(PERMISSIONS.stylists.manageSchedule)
  @ApiOperation({ summary: 'Eliminar una ausencia' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'timeOffId', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  async deleteTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('timeOffId', ParseUUIDPipe) timeOffId: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.removeTimeOff.execute({
      stylistId: id,
      timeOffId,
      actorId: user.sub,
    });
    return StylistResponse.from(stylist);
  }

  @Put(':id/skills')
  @RequirePermissions(PERMISSIONS.stylists.update)
  @ApiOperation({
    summary: 'Fijar qué servicios sabe hacer',
    description:
      'Reemplaza la lista completa. Cada habilidad puede sobreescribir la duración del ' +
      'catálogo y la comisión. Una lista **vacía** significa «puede hacerlo todo».',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  async updateSkills(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSkillsDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    const stylist = await this.setSkills.execute({
      stylistId: id,
      skills: dto.skills,
      actorId: user.sub,
    });
    return StylistResponse.from(stylist);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.stylists.delete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dar de baja a un profesional',
    description:
      'Borrado lógico. Sus citas y comisiones históricas siguen siendo consultables; solo ' +
      'deja de admitir reservas nuevas.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.deleteStylist.execute({ id, actorId: user.sub });
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.stylists.restore)
  @ApiOperation({ summary: 'Recuperar a un profesional dado de baja' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: StylistResponse })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistResponse> {
    return StylistResponse.from(await this.restoreStylist.execute({ id, actorId: user.sub }));
  }
}
