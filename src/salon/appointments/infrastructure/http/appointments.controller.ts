import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../../stylists/domain/stylist.repository';
import {
  ChangeAppointmentStatusUseCase,
  GetAppointmentUseCase,
  GetAvailabilityUseCase,
  GetCalendarUseCase,
  RescheduleAppointmentUseCase,
  ScheduleAppointmentUseCase,
  SearchAppointmentsUseCase,
} from '../../application/appointment.use-cases';
import type { AppointmentSortField } from '../../domain/appointment.repository';
import {
  AppointmentQueryDto,
  AppointmentResponse,
  AvailabilityQueryDto,
  AvailableSlotResponse,
  CalendarQueryDto,
  CancelAppointmentDto,
  RescheduleAppointmentDto,
  ScheduleAppointmentDto,
} from './appointment.dto';

/**
 * Adaptador HTTP de la agenda.
 *
 * Es el único controlador con **ámbito por filas** (ADR-0006). Quien tiene
 * `appointments.read` ve toda la agenda del salón; quien solo tiene
 * `appointments.read.own` ve exclusivamente la suya. La distinción no la puede hacer el
 * guard —sabe qué acciones, no sobre qué filas—, así que el controlador resuelve a qué
 * profesional corresponde el usuario y el caso de uso impone el filtro.
 */
@ApiTags('Agenda')
@Controller({ path: 'appointments', version: '1' })
export class AppointmentsController {
  constructor(
    private readonly scheduleAppointment: ScheduleAppointmentUseCase,
    private readonly rescheduleAppointment: RescheduleAppointmentUseCase,
    private readonly changeStatus: ChangeAppointmentStatusUseCase,
    private readonly searchAppointments: SearchAppointmentsUseCase,
    private readonly getAppointment: GetAppointmentUseCase,
    private readonly getAvailability: GetAvailabilityUseCase,
    private readonly getCalendar: GetCalendarUseCase,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
  ) {}

  /**
   * Resuelve el ámbito de filas del usuario.
   *
   * Devuelve `null` si puede ver toda la agenda, o el id de su ficha profesional si solo
   * puede ver la suya. Que un usuario con permiso `.own` **no tenga** ficha de profesional
   * es una configuración incoherente; se resuelve devolviendo un identificador imposible,
   * de modo que no vea nada en lugar de verlo todo.
   */
  private async ownScopeFor(user: AccessTokenClaims): Promise<string | null> {
    const permissions = new Set(user.permissions);

    if (permissions.has(WILDCARD_PERMISSION) || permissions.has(PERMISSIONS.appointments.read)) {
      return null;
    }

    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist?.id ?? '__sin_ficha_profesional__';
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.appointments.create, PERMISSIONS.appointments.createOwn)
  @ApiOperation({
    summary: 'Agendar una cita',
    description:
      'La duración se calcula sumando los servicios, con la duración propia del profesional ' +
      'y el margen de limpieza de cada uno. Precio y duración quedan **congelados**: subir ' +
      'la tarifa mañana no altera esta cita. Con `appointments.create.own`, solo puede ' +
      'agendarse a sí misma.',
  })
  @ApiCreatedResponse({ type: AppointmentResponse })
  @ApiConflictResponse({
    description:
      'El profesional ya tiene otra cita en esa franja. Lo garantiza una restricción ' +
      '`EXCLUDE` de PostgreSQL, así que es imposible saltárselo ni con peticiones simultáneas.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario, servicio retirado o profesional que no realiza el servicio',
  })
  @ApiForbiddenResponse({
    description: 'Con ámbito propio, el profesional de la cita no puede ser otra persona',
  })
  async create(
    @Body() dto: ScheduleAppointmentDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    const appointment = await this.scheduleAppointment.execute({
      tenantId: user.tenantId!,
      clientId: dto.clientId,
      stylistId: dto.stylistId,
      startsAt: dto.startsAt,
      serviceIds: dto.serviceIds,
      source: dto.source,
      notes: dto.notes,
      internalNotes: dto.internalNotes,
      force: dto.force,
      actorId: user.sub,
      restrictToStylistId: await this.ownScopeFor(user),
    });

    return AppointmentResponse.from(appointment);
  }

  @Get()
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({
    summary: 'Listar citas',
    description:
      'Con `appointments.read` se ve toda la agenda del salón. Con `appointments.read.own` ' +
      'solo la propia, y el filtro se impone en el servidor: enviar `stylistId` de otra ' +
      'persona no amplía el alcance.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/AppointmentResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: AppointmentQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ data: AppointmentResponse[]; meta: PageMetaResponse }> {
    const page = await this.searchAppointments.execute({
      filter: {
        stylistId: query.stylistId,
        clientId: query.clientId,
        status: query.status,
        onlyBlocking: query.onlyBlocking,
        from: query.from,
        to: query.to,
      },
      page: query.toPageRequest<AppointmentSortField>(),
      restrictToStylistId: await this.ownScopeFor(user),
    });

    return { data: page.data.map((a) => AppointmentResponse.from(a)), meta: page.meta };
  }

  @Get('availability')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({
    summary: 'Huecos libres para reservar',
    description:
      'Devuelve **momentos de inicio posibles**, no bloques libres: es lo que necesita la ' +
      'parrilla de horas de la interfaz. Tiene en cuenta el horario del profesional, sus ' +
      'ausencias, las citas ya reservadas y el margen de limpieza de cada servicio.',
  })
  @ApiOkResponse({ type: [AvailableSlotResponse] })
  async availability(@Query() query: AvailabilityQueryDto): Promise<AvailableSlotResponse[]> {
    return this.getAvailability.execute({
      stylistId: query.stylistId,
      date: query.date,
      serviceIds: query.serviceIds,
      granularityMinutes: query.granularityMinutes,
      minimumNoticeMinutes: query.minimumNoticeMinutes,
    });
  }

  @Get('calendar')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({
    summary: 'Vista de calendario',
    description:
      'Todas las citas de un rango, para pintar la parrilla. Máximo 31 días: un año entero ' +
      'traería decenas de miles de filas que ninguna pantalla puede mostrar.',
  })
  @ApiOkResponse({ type: [AppointmentResponse] })
  @ApiUnprocessableEntityResponse({ description: 'El rango supera 31 días' })
  async calendar(
    @Query() query: CalendarQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse[]> {
    const appointments = await this.getCalendar.execute({
      from: query.from,
      to: query.to,
      stylistIds: query.stylistIds,
      restrictToStylistId: await this.ownScopeFor(user),
    });

    return appointments.map((appointment) => AppointmentResponse.from(appointment));
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({ summary: 'Consultar una cita' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  @ApiNotFoundResponse({ description: 'No existe o pertenece a otro salón' })
  @ApiForbiddenResponse({
    description: 'La cita es de otro profesional y solo tiene ámbito propio',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    const appointment = await this.getAppointment.execute({
      id,
      restrictToStylistId: await this.ownScopeFor(user),
    });
    return AppointmentResponse.from(appointment);
  }

  @Patch(':id/reschedule')
  @RequirePermissions(PERMISSIONS.appointments.update)
  @ApiOperation({
    summary: 'Mover o reasignar una cita',
    description:
      'Cambiar la hora conserva la duración y **devuelve la cita a pendiente** si estaba ' +
      'confirmada: la clienta confirmó aquella hora, no ésta.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  @ApiConflictResponse({ description: 'La nueva franja choca con otra cita' })
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    const appointment = await this.rescheduleAppointment.execute({
      id,
      startsAt: dto.startsAt,
      stylistId: dto.stylistId,
      force: dto.force,
      actorId: user.sub,
    });
    return AppointmentResponse.from(appointment);
  }

  @Patch(':id/confirm')
  @RequirePermissions(PERMISSIONS.appointments.update)
  @ApiOperation({ summary: 'Confirmar la cita con la clienta' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    return this.transition(id, 'confirm', user);
  }

  @Patch(':id/start')
  @RequireAnyPermission(PERMISSIONS.appointments.update, PERMISSIONS.appointments.updateOwn)
  @ApiOperation({
    summary: 'Marcar el inicio de la cita',
    description: 'Una estilista puede iniciar **sus** citas con `appointments.update.own`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    return this.transition(id, 'start', user);
  }

  @Patch(':id/complete')
  @RequireAnyPermission(PERMISSIONS.appointments.update, PERMISSIONS.appointments.updateOwn)
  @ApiOperation({
    summary: 'Completar la cita',
    description:
      'Si nadie marcó el inicio se asume la hora prevista: en un salón con trabajo nadie ' +
      'pulsa «empezar», y negarse a cerrar la cita por eso solo haría que dejasen de usar ' +
      'el sistema.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    return this.transition(id, 'complete', user);
  }

  @Patch(':id/cancel')
  @RequirePermissions(PERMISSIONS.appointments.cancel)
  @ApiOperation({
    summary: 'Cancelar la cita',
    description:
      'Libera el hueco de inmediato. **Es irreversible**: si la clienta vuelve a llamar se ' +
      'reserva una nueva, para que el histórico conserve que hubo una cancelación.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  @ApiUnprocessableEntityResponse({ description: 'La cita ya está terminada' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAppointmentDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    const appointment = await this.changeStatus.execute({
      id,
      transition: 'cancel',
      reason: dto.reason,
      actorId: user.sub,
    });
    return AppointmentResponse.from(appointment);
  }

  @Patch(':id/no-show')
  @RequirePermissions(PERMISSIONS.appointments.update)
  @ApiOperation({
    summary: 'Marcar que la clienta no se presentó',
    description: 'Solo una vez pasada la hora de inicio: antes sería prejuzgar.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  @ApiUnprocessableEntityResponse({ description: 'La cita todavía no ha empezado' })
  async noShow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    return this.transition(id, 'no-show', user);
  }

  private async transition(
    id: string,
    transition: 'confirm' | 'start' | 'complete' | 'no-show',
    user: AccessTokenClaims,
  ): Promise<AppointmentResponse> {
    const appointment = await this.changeStatus.execute({
      id,
      transition,
      actorId: user.sub,
      restrictToStylistId: await this.ownScopeFor(user),
    });
    return AppointmentResponse.from(appointment);
  }
}
