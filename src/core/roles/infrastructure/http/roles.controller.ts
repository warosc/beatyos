import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PERMISSIONS } from '../../../permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  CreateRoleUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from '../../application/role.use-cases';
import {
  EmptyEnvelopeResponse,
  PermissionListEnvelopeResponse,
  RoleEnvelopeResponse,
  RoleListEnvelopeResponse,
  toRoleResponse,
} from './roles.response';
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
@ApiTags('Roles')
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(
    private list: ListRolesUseCase,
    private createRole: CreateRoleUseCase,
    private updateRole: UpdateRoleUseCase,
  ) {}
  @Get()
  @ApiOperation({ operationId: 'roles_list', summary: 'Listar los roles disponibles en el salón' })
  @ApiOkResponse({ type: RoleListEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.roles.read)
  async all(@CurrentUser() u: AccessTokenClaims) {
    return (await this.list.execute(u.tenantId!)).map(toRoleResponse);
  }
  @Get('permissions')
  @ApiOperation({ operationId: 'roles_permissions', summary: 'Catálogo fijo de permisos' })
  @ApiOkResponse({ type: PermissionListEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.roles.read)
  permissions() {
    return this.list.permissions();
  }
  @Post()
  @ApiOperation({ operationId: 'roles_create', summary: 'Crear un rol propio del salón' })
  @ApiCreatedResponse({ type: RoleEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.roles.create)
  async create(@Body() dto: CreateRoleDto, @CurrentUser() u: AccessTokenClaims) {
    return toRoleResponse(
      await this.createRole.execute({
        ...dto,
        description: dto.description ?? null,
        tenantId: u.tenantId!,
        actorId: u.sub,
      }),
    );
  }
  @Patch(':id')
  @ApiOperation({ operationId: 'roles_update', summary: 'Actualizar un rol propio del salón' })
  @ApiOkResponse({ type: RoleEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.roles.update)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return toRoleResponse(
      await this.updateRole.execute({ ...dto, id, tenantId: u.tenantId!, actorId: u.sub }),
    );
  }
  @Delete(':id')
  @ApiOperation({ operationId: 'roles_delete', summary: 'Eliminar un rol propio del salón' })
  @ApiOkResponse({ type: EmptyEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.roles.delete)
  async remove(@Param('id') id: string, @CurrentUser() u: AccessTokenClaims) {
    await this.updateRole.delete(id, u.tenantId!, u.sub);
  }
}
