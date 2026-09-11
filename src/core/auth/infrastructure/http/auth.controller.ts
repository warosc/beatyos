import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { ApplyThrottler } from '../../../../shared/infrastructure/security/scoped-throttler.guard';

import type { AccessTokenClaims } from '../../../../shared/application/ports';
import {
  Authenticated,
  CurrentUser,
  Public,
} from '../../../../shared/infrastructure/http/decorators';
import { LoginUseCase } from '../../application/login.use-case';
import { RefreshTokenUseCase } from '../../application/refresh-token.use-case';
import {
  ChangePasswordUseCase,
  GetCurrentUserUseCase,
  LogoutUseCase,
} from '../../application/session.use-cases';
import {
  ChangePasswordDto,
  LoginDto,
  LogoutDto,
  ProfileResponse,
  RefreshTokenDto,
  SessionResponse,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './auth.dto';
import {
  RequestPasswordResetUseCase,
  ResetPasswordUseCase,
} from '../../application/password-reset.use-cases';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';

/**
 * Adaptador HTTP de autenticación.
 *
 * El controlador no tiene lógica: traduce petición a entrada de caso de uso y devuelve
 * su salida. Si algún día apareciera aquí un `if` sobre reglas de negocio, sería la
 * señal de que algo se ha quedado en la capa equivocada (ADR-0001).
 */
@ApiTags('Autenticación')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
    private readonly refresh: RefreshTokenUseCase,
    private readonly logout: LogoutUseCase,
    private readonly changePassword: ChangePasswordUseCase,
    private readonly currentUser: GetCurrentUserUseCase,
    private readonly requestPasswordReset: RequestPasswordResetUseCase,
    private readonly resetPassword: ResetPasswordUseCase,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApplyThrottler('auth')
  @ApiOperation({ summary: 'Solicitar recuperación sin revelar si el correo existe' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    const result = await this.requestPasswordReset.execute(dto);
    const development = this.config.get('NODE_ENV', { infer: true }) !== 'production';
    return {
      message: 'Si la cuenta existe, enviaremos instrucciones para recuperar el acceso.',
      ...(development && result.token
        ? { resetPath: `/reset-password?token=${result.token}` }
        : {}),
    };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApplyThrottler('auth')
  @ApiOperation({ summary: 'Establecer una contraseña nueva con un token de un solo uso' })
  async resetForgottenPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.resetPassword.execute(dto);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Activa la ventana `auth`, mucho más estrecha que la general y configurable por
  // entorno (AUTH_THROTTLE_LIMIT / AUTH_THROTTLE_TTL). Es la defensa contra la fuerza
  // bruta distribuida, complementaria al bloqueo por cuenta: aquélla la eludiría un
  // atacante con muchas IP, y ésta por sí sola permitiría bloquear cuentas ajenas.
  @ApplyThrottler('auth')
  @ApiOperation({
    summary: 'Iniciar sesión',
    description:
      'Devuelve un access token de 15 minutos y un refresh token de 7 días. ' +
      'Por seguridad, un correo inexistente y una contraseña incorrecta producen la misma ' +
      'respuesta: distinguirlos permitiría enumerar los usuarios del sistema.',
  })
  @ApiBody({ type: LoginDto })
  @ApiUnauthorizedResponse({ description: 'Credenciales incorrectas' })
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos; espere antes de reintentar' })
  async loginUser(@Body() dto: LoginDto, @Req() request: Request): Promise<SessionResponse> {
    const session = await this.login.execute({
      email: dto.email,
      password: dto.password,
      userAgent: request.header('user-agent') ?? null,
      ipAddress: this.clientIp(request),
    });
    return session as SessionResponse;
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApplyThrottler('auth')
  @ApiOperation({
    summary: 'Renovar la sesión',
    description:
      'Rota el refresh token: el enviado deja de ser válido y se devuelve uno nuevo. ' +
      'Presentar un token ya rotado se interpreta como robo y revoca toda la cadena de ' +
      'sesiones nacida de ese inicio de sesión (ADR-0005).',
  })
  @ApiUnauthorizedResponse({ description: 'Refresh token inválido, caducado o ya utilizado' })
  async refreshSession(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<SessionResponse> {
    const session = await this.refresh.execute({
      refreshToken: dto.refreshToken,
      userAgent: request.header('user-agent') ?? null,
      ipAddress: this.clientIp(request),
    });
    return session as SessionResponse;
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cerrar sesión',
    description:
      'Revoca la sesión actual o, con `allDevices`, todas las del usuario. ' +
      'Es idempotente: cerrar una sesión ya cerrada devuelve 200, porque el resultado que ' +
      'el cliente pedía ya se cumple.',
  })
  async logoutUser(
    @Body() dto: LogoutDto,
    @Req() request: Request & { user?: AccessTokenClaims },
  ): Promise<{ revokedSessions: number }> {
    // Público a propósito: con el access token ya caducado, el cliente debe poder seguir
    // revocando su refresh token —que es exactamente cuando más lo necesita—. No se
    // concede nada por ser público: el caso de uso deduce el usuario del propio token y
    // verifica su posesión antes de revocar nada.
    return this.logout.execute({
      userId: request.user?.sub ?? null,
      refreshToken: dto.refreshToken,
      allDevices: dto.allDevices ?? false,
    });
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({
    summary: 'Perfil del usuario autenticado',
    description:
      'Se lee de la base de datos, no de los claims del token: la interfaz debe pintar el ' +
      'estado actual y no el de hace hasta quince minutos.',
  })
  @ApiUnauthorizedResponse({ description: 'Token ausente o inválido' })
  async me(@CurrentUser() user: AccessTokenClaims): Promise<ProfileResponse> {
    const profile = await this.currentUser.execute(user.sub);
    return profile as ProfileResponse;
  }

  @Post('change-password')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cambiar la propia contraseña',
    description:
      'Exige la contraseña actual aunque la sesión esté abierta, y cierra todas las ' +
      'sesiones al completarse.',
  })
  @ApiBadRequestResponse({ description: 'La contraseña nueva no cumple la política' })
  @ApiUnauthorizedResponse({ description: 'La contraseña actual no es correcta' })
  async changeOwnPassword(
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.changePassword.execute({
      userId: user.sub,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
  }

  private clientIp(request: Request): string | null {
    const forwarded = request.header('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
    return request.ip ?? null;
  }
}
