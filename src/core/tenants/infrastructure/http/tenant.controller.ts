import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PERMISSIONS } from '../../../permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { ForbiddenActionError } from '../../../../shared/domain/errors';
import {
  Authenticated,
  CurrentUser,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import {
  GetTenantProfileUseCase,
  UpdateTenantProfileUseCase,
} from '../../application/tenant-profile.use-cases';
import { BRAND_THEMES, type BrandTheme } from '../../domain/tenant-profile.repository';

class UpdateTenantProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) legalName?: string;
  @ApiPropertyOptional({ description: 'NIT' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(160) email?: string;

  @ApiPropertyOptional({ enum: BRAND_THEMES, description: 'Combinación de colores del salón' })
  @IsOptional()
  @IsIn(BRAND_THEMES)
  brandTheme?: BrandTheme;

  @ApiPropertyOptional({ description: 'Línea libre al pie de los comprobantes' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptNote?: string;
}

class TenantProfileResponse {
  id!: string;
  name!: string;
  @ApiProperty({ nullable: true, type: String }) legalName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'NIT' }) taxId!: string | null;
  @ApiProperty({ nullable: true, type: String }) addressLine!: string | null;
  @ApiProperty({ nullable: true, type: String }) city!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  email!: string;
  @ApiProperty({ enum: BRAND_THEMES }) brandTheme!: string;
  @ApiProperty({ nullable: true, type: String }) receiptNote!: string | null;
}

class TenantProfileEnvelopeResponse {
  @ApiProperty({ type: TenantProfileResponse }) data!: TenantProfileResponse;
}

const tenantOf = (user: AccessTokenClaims): string => {
  if (!user.tenantId) throw new ForbiddenActionError('tenant.profile', 'No perteneces a un salón');
  return user.tenantId;
};

@ApiTags('Salón')
@Controller({ path: 'tenant', version: '1' })
export class TenantController {
  constructor(
    private readonly getProfile: GetTenantProfileUseCase,
    private readonly updateProfile: UpdateTenantProfileUseCase,
  ) {}

  // Cualquiera del salón: quien cobra necesita los datos para imprimir el comprobante.
  @Get('profile')
  @Authenticated()
  @ApiOperation({ operationId: 'tenant_profile', summary: 'Datos del salón para comprobantes' })
  @ApiOkResponse({ type: TenantProfileEnvelopeResponse })
  profile(@CurrentUser() user: AccessTokenClaims) {
    return this.getProfile.execute(tenantOf(user));
  }

  @Patch('profile')
  @RequirePermissions(PERMISSIONS.settings.update)
  @ApiOperation({ operationId: 'tenant_profile_update', summary: 'Modificar los datos del salón' })
  @ApiOkResponse({ type: TenantProfileEnvelopeResponse })
  update(@Body() dto: UpdateTenantProfileDto, @CurrentUser() user: AccessTokenClaims) {
    return this.updateProfile.execute({ tenantId: tenantOf(user), patch: dto, actorId: user.sub });
  }
}
