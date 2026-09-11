import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTOs del borde HTTP.
 *
 * Validan **forma**, no reglas de negocio: que el correo parezca un correo y que la
 * contraseña no venga vacía. La política de contraseñas de verdad la aplica el dominio
 * (`User.validatePasswordStrength`), porque también debe regir para un seed o un script
 * que nunca pasan por aquí.
 *
 * La duplicación de una regla en ambos sitios sería el error clásico: acabarían
 * divergiendo, y la del borde daría por buena una contraseña que el dominio rechaza.
 */

export class LoginDto {
  @ApiProperty({ example: 'ana@salonbelleza.es', description: 'Correo electrónico del usuario' })
  @IsEmail({}, { message: 'Introduzca un correo electrónico válido' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ example: 'ContrasenaSegura123', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1, { message: 'La contraseña es obligatoria' })
  // Tope de longitud: sin él, un cuerpo de varios megabytes en este campo obligaría a
  // Argon2 a procesarlo y bastarían unas pocas peticiones para agotar la CPU.
  @MaxLength(128)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh token obtenido en el inicio de sesión o en el refresco anterior',
  })
  @IsString()
  @MinLength(1)
  // 4096 y no 2048: un access token de una propietaria con los 80 permisos del catálogo
  // ocupa 2 377 bytes (ADR-0006). Con el tope anterior, presentarlo aquí por error daba
  // un 400 por longitud en lugar del 401 que corresponde, lo que confundía el
  // diagnóstico. El tope sigue existiendo para acotar el trabajo de verificación.
  @MaxLength(4096)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Refresh token de la sesión que se cierra' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;

  @ApiPropertyOptional({
    description: 'Cierra la sesión en todos los dispositivos, no solo en el actual',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'Contraseña actual. Se exige aunque la sesión esté abierta.' })
  @IsString()
  @MinLength(1, { message: 'Debe indicar su contraseña actual' })
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({
    description:
      'Contraseña nueva. Mínimo 12 caracteres, con mayúscula, minúscula y número. ' +
      'No se exige carácter especial: empuja a contraseñas del tipo "Password1!", que son ' +
      'peores que una frase larga.',
    minLength: 12,
    example: 'MiSalonFavorito2026',
  })
  @IsString()
  @MinLength(12, { message: 'La contraseña debe tener al menos 12 caracteres' })
  @MaxLength(128)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'propietaria@bella-vista.es' })
  @IsEmail({}, { message: 'Introduzca un correo electrónico válido' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(32) @MaxLength(256) token!: string;
  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class SessionUserResponse {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({
    nullable: true,
    description: 'Salón al que pertenece. Nulo en cuentas de plataforma.',
  })
  tenantId!: string | null;
  @ApiProperty({ type: [String], example: ['MANAGER'] }) roles!: string[];
  @ApiProperty({
    type: [String],
    description: 'Permisos efectivos: la unión de los de todos sus roles',
    example: ['appointments.create', 'clients.read'],
  })
  permissions!: string[];
}

export class SessionResponse {
  @ApiProperty({ description: 'Token de acceso. Caduca en 15 minutos (ADR-0005).' })
  accessToken!: string;

  @ApiProperty({
    description:
      'Token de refresco. Se rota en cada uso: el que se envía deja de valer y se recibe ' +
      'uno nuevo. Reutilizar uno ya rotado cierra todas las sesiones de esa cadena.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' }) tokenType!: string;

  @ApiProperty({ example: 900, description: 'Segundos de validez del token de acceso' })
  expiresIn!: number;

  @ApiProperty({ type: SessionUserResponse }) user!: SessionUserResponse;
}

export class ProfileResponse extends SessionUserResponse {
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ example: 'es-GT' }) locale!: string;
  @ApiProperty({ example: 'ACTIVE' }) status!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) lastLoginAt!: string | null;
}
