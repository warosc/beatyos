import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { Public } from '../../../../shared/infrastructure/http/decorators';
import {
  confirmationTokenDigest,
  PublicAppointmentLinkUseCase,
} from '../../application/reminder.use-cases';
import { REMINDER_LOG, type ReminderLog } from '../../domain/agenda.ports';
import { PublicAppointmentResponse, PublicCancelDto } from './agenda.dto';

/**
 * Enlace del recordatorio: la clienta confirma o cancela sin cuenta ni contraseña.
 *
 * El enlace **es** la credencial, y solo sirve para su cita: ver la hora, confirmarla o
 * cancelarla. No permite reservar ni mover —eso sigue siendo cosa del salón—. Se guarda su
 * hash, nunca el enlace; uno nuevo invalida el anterior, y deja de servir cuando la cita
 * pasa.
 *
 * El salón se averigua por el propio enlace, y a partir de ahí todo corre dentro de él con
 * el aislamiento normal.
 */
@ApiTags('Enlace de la clienta')
@Controller({ path: 'public/appointment-links', version: '1' })
export class PublicAppointmentLinkController {
  constructor(
    private readonly links: PublicAppointmentLinkUseCase,
    @Inject(REMINDER_LOG) private readonly log: ReminderLog,
  ) {}

  private async withinSalon<T>(
    token: string,
    work: (appointmentId: string) => Promise<T>,
  ): Promise<T> {
    // Un token mal formado ni siquiera se busca: no hay enlace válido de otra longitud.
    const found =
      /^[A-Za-z0-9_-]{16,64}$/.test(token) &&
      (await this.log.findByConfirmationToken(confirmationTokenDigest(token)));
    if (!found) throw new EntityNotFoundError('Enlace de cita', 'no válido');
    return RequestContextStore.runAsTenant(found.tenantId, () => work(found.appointmentId));
  }

  @Get(':token')
  @Public()
  @ApiOperation({ summary: 'Ver la cita del enlace' })
  @ApiOkResponse({ type: PublicAppointmentResponse })
  @ApiNotFoundResponse({ description: 'El enlace no existe o fue sustituido por otro' })
  async view(@Param('token') token: string): Promise<PublicAppointmentResponse> {
    return PublicAppointmentResponse.from(
      await this.withinSalon(token, (id) => this.links.view(id)),
    );
  }

  @Post(':token/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar la cita' })
  @ApiOkResponse({ type: PublicAppointmentResponse })
  async confirm(@Param('token') token: string): Promise<PublicAppointmentResponse> {
    return PublicAppointmentResponse.from(
      await this.withinSalon(token, (id) => this.links.confirm(id)),
    );
  }

  @Post(':token/cancel')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar la cita' })
  @ApiOkResponse({ type: PublicAppointmentResponse })
  async cancel(
    @Param('token') token: string,
    @Body() dto: PublicCancelDto,
  ): Promise<PublicAppointmentResponse> {
    return PublicAppointmentResponse.from(
      await this.withinSalon(token, (id) => this.links.cancel(id, dto.reason)),
    );
  }
}
