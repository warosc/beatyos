import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import { PERMISSIONS } from '../../../permissions/domain/permission-catalog';
import {
  AdminResetPasswordUseCase,
  PasswordResetRequestsUseCase,
} from '../../application/password-reset.use-cases';
import { AdminResetPasswordDto, PasswordResetRequestListResponse } from './auth.dto';

/**
 * Contraseña asignada por la propietaria.
 *
 * Cuelga de `/users` porque es una operación sobre un usuario, pero vive en este módulo:
 * cerrar las sesiones del afectado exige el almacén de refresh tokens, que es de `auth`,
 * y `users` no puede importar `auth` sin crear un ciclo.
 */
@ApiTags('Usuarios')
@Controller({ path: 'users', version: '1' })
export class UserPasswordController {
  constructor(private readonly resetPassword: AdminResetPasswordUseCase) {}

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'users_resetPassword',
    summary: 'Asignar una contraseña nueva a otro usuario del salón',
    description:
      'No pide la contraseña actual: es la vía para quien la olvidó. Cierra todas las ' +
      'sesiones del usuario y resuelve su solicitud pendiente, si la tenía.',
  })
  @ApiNoContentResponse({ description: 'Contraseña cambiada' })
  @RequirePermissions(PERMISSIONS.users.resetPassword)
  async reset(
    @Param('id') id: string,
    @Body() dto: AdminResetPasswordDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.resetPassword.execute({
      userId: id,
      newPassword: dto.newPassword,
      actorId: user.sub,
    });
  }
}

/** Avisos de «olvidé mi contraseña» que llegan a la propietaria. */
@ApiTags('Usuarios')
@Controller({ path: 'password-reset-requests', version: '1' })
export class PasswordResetRequestsController {
  constructor(private readonly requests: PasswordResetRequestsUseCase) {}

  @Get()
  @ApiOperation({
    operationId: 'passwordResetRequests_list',
    summary: 'Solicitudes de contraseña pendientes en el salón',
  })
  @ApiOkResponse({ type: PasswordResetRequestListResponse })
  @RequirePermissions(PERMISSIONS.users.resetPassword)
  list() {
    return this.requests.list();
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'passwordResetRequests_dismiss',
    summary: 'Descartar una solicitud de contraseña sin cambiar nada',
  })
  @ApiNoContentResponse({ description: 'Solicitud descartada' })
  @RequirePermissions(PERMISSIONS.users.resetPassword)
  async dismiss(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims): Promise<void> {
    await this.requests.dismiss(id, user.sub);
  }
}
