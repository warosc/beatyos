import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PERMISSIONS } from '../../../permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  CreateUserUseCase,
  SearchUsersUseCase,
  UpdateUserUseCase,
} from '../../application/user-admin.use-cases';
import type { UserStatusValue } from '../../domain/user.entity';
import {
  EmptyEnvelopeResponse,
  UserEnvelopeResponse,
  UserPageResponse,
  toUserResponse,
} from './users.response';
class UserQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional()
  @IsEnum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION'])
  status?: UserStatusValue;
  @IsOptional() @IsString() roleCode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
  @IsString() @MaxLength(100) firstName!: string;
  @IsString() @MaxLength(100) lastName!: string;
  @IsOptional() @IsString() phone?: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roleIds!: string[];
}
class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsEnum(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}
class AssignRolesDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roleIds!: string[];
}
@ApiTags('Usuarios')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private search: SearchUsersUseCase,
    private createUser: CreateUserUseCase,
    private updateUser: UpdateUserUseCase,
  ) {}
  @Get()
  @ApiOperation({ operationId: 'users_list', summary: 'Buscar usuarios del salón' })
  @ApiOkResponse({ type: UserPageResponse })
  @RequirePermissions(PERMISSIONS.users.read)
  async all(@Query() q: UserQueryDto) {
    const p = await this.search.execute(q);
    return { data: p.data.map(toUserResponse), meta: p.meta };
  }
  @Get(':id')
  @ApiOperation({ operationId: 'users_get', summary: 'Consultar un usuario' })
  @ApiOkResponse({ type: UserEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.read)
  async detail(@Param('id') id: string) {
    return toUserResponse(await this.search.detail(id));
  }
  @Post()
  @ApiOperation({ operationId: 'users_create', summary: 'Crear un usuario' })
  @ApiCreatedResponse({ type: UserEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.create)
  async create(@Body() d: CreateUserDto, @CurrentUser() u: AccessTokenClaims) {
    return toUserResponse(
      await this.createUser.execute({ ...d, tenantId: u.tenantId!, actorId: u.sub }),
    );
  }
  @Patch(':id')
  @ApiOperation({ operationId: 'users_update', summary: 'Actualizar el perfil de un usuario' })
  @ApiOkResponse({ type: UserEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.update)
  async update(
    @Param('id') id: string,
    @Body() d: UpdateUserDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return toUserResponse(await this.updateUser.profile({ ...d, id, actorId: u.sub }));
  }
  @Put(':id/roles')
  @ApiOperation({ operationId: 'users_assignRoles', summary: 'Reasignar los roles de un usuario' })
  @ApiOkResponse({ type: UserEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.assignRoles)
  async roles(
    @Param('id') id: string,
    @Body() d: AssignRolesDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return toUserResponse(
      await this.updateUser.assign({ ...d, id, tenantId: u.tenantId!, actorId: u.sub }),
    );
  }
  @Delete(':id')
  @ApiOperation({ operationId: 'users_delete', summary: 'Dar de baja a un usuario' })
  @ApiOkResponse({ type: EmptyEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.delete)
  async remove(@Param('id') id: string, @CurrentUser() u: AccessTokenClaims) {
    await this.updateUser.remove(id, u.sub);
  }
  @Post(':id/restore')
  @ApiOperation({ operationId: 'users_restore', summary: 'Restaurar un usuario dado de baja' })
  @ApiCreatedResponse({ type: UserEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.users.restore)
  async restore(@Param('id') id: string, @CurrentUser() u: AccessTokenClaims) {
    return toUserResponse(await this.updateUser.restore(id, u.sub));
  }
}
