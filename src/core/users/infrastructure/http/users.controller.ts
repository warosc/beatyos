import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
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
import type { User, UserStatusValue } from '../../domain/user.entity';
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
const present = (u: User) => ({
  id: u.id,
  email: u.email.value,
  firstName: u.name.firstName,
  lastName: u.name.lastName,
  fullName: u.name.full,
  phone: u.phone?.value ?? null,
  status: u.status,
  locale: u.locale,
  roles: u.roles.map((r) => ({ id: r.id, code: r.code })),
  permissions: u.effectivePermissions,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.audit.createdAt,
  deletedAt: u.audit.deletedAt,
});
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private search: SearchUsersUseCase,
    private createUser: CreateUserUseCase,
    private updateUser: UpdateUserUseCase,
  ) {}
  @Get() @RequirePermissions(PERMISSIONS.users.read) async all(@Query() q: UserQueryDto) {
    const p = await this.search.execute(q);
    return { data: p.data.map(present), meta: p.meta };
  }
  @Get(':id') @RequirePermissions(PERMISSIONS.users.read) async detail(@Param('id') id: string) {
    return present(await this.search.detail(id));
  }
  @Post() @RequirePermissions(PERMISSIONS.users.create) async create(
    @Body() d: CreateUserDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return present(await this.createUser.execute({ ...d, tenantId: u.tenantId!, actorId: u.sub }));
  }
  @Patch(':id') @RequirePermissions(PERMISSIONS.users.update) async update(
    @Param('id') id: string,
    @Body() d: UpdateUserDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return present(await this.updateUser.profile({ ...d, id, actorId: u.sub }));
  }
  @Put(':id/roles') @RequirePermissions(PERMISSIONS.users.assignRoles) async roles(
    @Param('id') id: string,
    @Body() d: AssignRolesDto,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return present(
      await this.updateUser.assign({ ...d, id, tenantId: u.tenantId!, actorId: u.sub }),
    );
  }
  @Delete(':id') @RequirePermissions(PERMISSIONS.users.delete) async remove(
    @Param('id') id: string,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    await this.updateUser.remove(id, u.sub);
  }
  @Post(':id/restore') @RequirePermissions(PERMISSIONS.users.restore) async restore(
    @Param('id') id: string,
    @CurrentUser() u: AccessTokenClaims,
  ) {
    return present(await this.updateUser.restore(id, u.sub));
  }
}
