import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PERMISSIONS } from '../../../permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  CreateRoleUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from '../../application/role.use-cases';
class CreateRoleDto {
  @IsString() @Matches(/^[A-Za-z][A-Za-z0-9_-]{1,39}$/) code!: string;
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsArray() @IsString({ each: true }) permissionCodes!: string[];
}
class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) permissionCodes?: string[];
}
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(
    private list: ListRolesUseCase,
    private createRole: CreateRoleUseCase,
    private updateRole: UpdateRoleUseCase,
  ) {}
  @Get() @RequirePermissions(PERMISSIONS.roles.read) all(@CurrentUser() u: AccessTokenClaims) {
    return this.list.execute(u.tenantId!);
  }
  @Get('permissions') @RequirePermissions(PERMISSIONS.roles.read) permissions() {
    return this.list.permissions();
  }
  @Post() @RequirePermissions(PERMISSIONS.roles.create) create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return this.createRole.execute({
      ...dto,
      description: dto.description ?? null,
      tenantId: u.tenantId!,
      actorId: u.sub,
    });
  }
  @Patch(':id') @RequirePermissions(PERMISSIONS.roles.update) update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return this.updateRole.execute({ ...dto, id, tenantId: u.tenantId!, actorId: u.sub });
  }
  @Delete(':id') @RequirePermissions(PERMISSIONS.roles.delete) async remove(
    @Param('id') id: string,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    await this.updateRole.delete(id, u.tenantId!, u.sub);
  }
}
