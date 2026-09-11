import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ConfigService } from '@nestjs/config';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import {
  CreateCategoryUseCase,
  CreateServiceUseCase,
  DeleteCategoryUseCase,
  DeleteServiceUseCase,
  GetCategoryTreeUseCase,
  GetServiceUseCase,
  RestoreServiceUseCase,
  SearchCategoriesUseCase,
  SearchServicesUseCase,
  SetServiceConsumablesUseCase,
  UpdateCategoryUseCase,
  UpdateServiceUseCase,
} from '../../application/catalog.use-cases';
import type { CategorySortField, ServiceSortField } from '../../domain/catalog.repositories';
import {
  CategoryQueryDto,
  CategoryResponse,
  CreateCategoryDto,
  CreateServiceDto,
  ServiceQueryDto,
  ServiceResponse,
  SetConsumablesDto,
  UpdateCategoryDto,
  UpdateServiceDto,
} from './catalog.dto';

/**
 * Catálogo de servicios.
 *
 * El precio se envía y se devuelve como **cadena decimal**. Un número en JSON pasa por
 * coma flotante binaria y `25.10` deja de ser exactamente `25.10`, que en una factura se
 * nota (ADR-0010).
 */
@ApiTags('Servicios')
@Controller({ path: 'services', version: '1' })
export class ServicesController {
  /**
   * Moneda de operación del salón.
   *
   * Sale de la configuración, **no escrita a fuego**. Estuvo fijada aquí y produjo una
   * incoherencia real: este controlador creaba servicios en una moneda mientras el
   * repositorio de clientas reconstruía `totalSpent` con la de `DEFAULT_CURRENCY`. `Money`
   * se niega a operar entre monedas distintas, así que la primera factura que tocase el
   * gasto acumulado de una clienta habría reventado.
   */
  private readonly currency: string;

  constructor(
    private readonly createService: CreateServiceUseCase,
    private readonly updateService: UpdateServiceUseCase,
    private readonly getService: GetServiceUseCase,
    private readonly searchServices: SearchServicesUseCase,
    private readonly deleteService: DeleteServiceUseCase,
    private readonly restoreService: RestoreServiceUseCase,
    private readonly setConsumables: SetServiceConsumablesUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Post()
  @RequirePermissions(PERMISSIONS.services.create)
  @ApiOperation({
    summary: 'Crear un servicio',
    description:
      'Recuerde la diferencia entre `durationMinutes` —lo que se cobra— y `bufferMinutes` ' +
      '—el margen de limpieza que bloquea agenda pero no se factura—.',
  })
  @ApiCreatedResponse({ type: ServiceResponse })
  @ApiConflictResponse({ description: 'Ya existe un servicio con ese código' })
  @ApiUnprocessableEntityResponse({ description: 'La categoría indicada no admite servicios' })
  async create(
    @Body() dto: CreateServiceDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceResponse> {
    const service = await this.createService.execute({
      ...dto,
      tenantId: user.tenantId!,
      // La moneda es la del salón; el cliente no la elige por servicio.
      currency: this.currency,
      actorId: user.sub,
    });
    return ServiceResponse.from(service);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.services.read)
  @ApiOperation({
    summary: 'Listar servicios',
    description:
      'Use `maxDurationMinutes` para ofrecer solo lo que cabe en un hueco concreto de la agenda.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/ServiceResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: ServiceQueryDto,
  ): Promise<{ data: ServiceResponse[]; meta: PageMetaResponse }> {
    const page = await this.searchServices.execute({
      filter: {
        search: query.search,
        categoryId: query.categoryId,
        isActive: query.isActive,
        bookableOnline: query.bookableOnline,
        maxDurationMinutes: query.maxDurationMinutes,
      },
      page: query.toPageRequest<ServiceSortField>(),
      includeDeleted: query.includeDeleted,
    });

    return { data: page.data.map((service) => ServiceResponse.from(service)), meta: page.meta };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.services.read)
  @ApiOperation({ summary: 'Consultar un servicio' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ServiceResponse })
  @ApiNotFoundResponse({ description: 'No existe o pertenece a otro salón' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceResponse> {
    return ServiceResponse.from(await this.getService.execute(id));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.services.update)
  @ApiOperation({
    summary: 'Modificar un servicio',
    description:
      'Cambiar el precio **no altera las citas ya agendadas**: cada una congeló su tarifa al ' +
      'reservarse. Use `isActive: false` para retirarlo del catálogo conservando el histórico.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ServiceResponse })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceResponse> {
    const service = await this.updateService.execute({ ...dto, id, actorId: user.sub });
    return ServiceResponse.from(service);
  }

  @Put(':id/consumables')
  @RequirePermissions(PERMISSIONS.services.update)
  @ApiOperation({
    summary: 'Definir el escandallo del servicio',
    description:
      'Qué productos consume al ejecutarse. Alimenta los movimientos de inventario al ' +
      'completar la cita y permite calcular el margen real: sin esto, el margen se ' +
      'calcularía como si el tinte fuese gratis.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ServiceResponse })
  async updateConsumables(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetConsumablesDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceResponse> {
    const service = await this.setConsumables.execute({
      serviceId: id,
      consumables: dto.consumables,
      actorId: user.sub,
    });
    return ServiceResponse.from(service);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.services.delete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar un servicio',
    description:
      'Borrado lógico. Para dejar de ofrecerlo conservando la ficha, prefiera ' +
      '`PATCH` con `isActive: false`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.deleteService.execute({ id, actorId: user.sub });
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.services.restore)
  @ApiOperation({ summary: 'Recuperar un servicio eliminado' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ServiceResponse })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceResponse> {
    return ServiceResponse.from(await this.restoreService.execute({ id, actorId: user.sub }));
  }
}

/**
 * Categorías del catálogo, comunes a servicios y productos.
 *
 * Se discriminan por `kind`. Una sola entidad y un solo controlador en lugar de dos
 * gemelos: el árbol y sus reglas son idénticos (ADR-0002).
 */
@ApiTags('Categorías')
@Controller({ path: 'categories', version: '1' })
export class CategoriesController {
  constructor(
    private readonly createCategory: CreateCategoryUseCase,
    private readonly updateCategory: UpdateCategoryUseCase,
    private readonly searchCategories: SearchCategoriesUseCase,
    private readonly categoryTree: GetCategoryTreeUseCase,
    private readonly deleteCategory: DeleteCategoryUseCase,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.categories.create)
  @ApiOperation({ summary: 'Crear una categoría' })
  @ApiCreatedResponse({ type: CategoryResponse })
  @ApiUnprocessableEntityResponse({
    description: 'La categoría madre es de otro tipo, o se supera la profundidad máxima',
  })
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CategoryResponse> {
    const category = await this.createCategory.execute({
      ...dto,
      tenantId: user.tenantId!,
      actorId: user.sub,
    });
    return CategoryResponse.from(category);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.categories.read)
  @ApiOperation({ summary: 'Listar categorías' })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/CategoryResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: CategoryQueryDto,
  ): Promise<{ data: CategoryResponse[]; meta: PageMetaResponse }> {
    const page = await this.searchCategories.execute({
      filter: { kind: query.kind, search: query.search, isActive: query.isActive },
      page: query.toPageRequest<CategorySortField>(),
      includeDeleted: query.includeDeleted,
    });

    return { data: page.data.map((c) => CategoryResponse.from(c)), meta: page.meta };
  }

  @Get('tree')
  @RequirePermissions(PERMISSIONS.categories.read)
  @ApiOperation({
    summary: 'Árbol completo de categorías',
    description:
      'Devuelve todas las categorías del tipo indicado en una sola consulta, ordenadas. El ' +
      'cliente arma la jerarquía con `parentId`: pedirlo nivel a nivel serían tantas ' +
      'peticiones como profundidad tenga el árbol.',
  })
  @ApiQuery({ name: 'kind', enum: ['SERVICE', 'PRODUCT'] })
  @ApiOkResponse({ type: [CategoryResponse] })
  async tree(@Query('kind') kind: 'SERVICE' | 'PRODUCT'): Promise<CategoryResponse[]> {
    const categories = await this.categoryTree.execute(kind ?? 'SERVICE');
    return categories.map((category) => CategoryResponse.from(category));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.categories.update)
  @ApiOperation({
    summary: 'Modificar una categoría',
    description:
      'Renombrarla **no** cambia su `slug`, que puede estar en una URL pública. Envíe ' +
      '`parentId: null` para convertirla en raíz.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: CategoryResponse })
  @ApiUnprocessableEntityResponse({
    description: 'El movimiento crearía un ciclo o supera la profundidad máxima',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CategoryResponse> {
    const category = await this.updateCategory.execute({ ...dto, id, actorId: user.sub });
    return CategoryResponse.from(category);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.categories.delete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar una categoría vacía',
    description:
      'Se niega si cuelga algo de ella. Borrar en cascada haría desaparecer servicios que ' +
      'nadie pidió eliminar; dejar huérfanos los volvería invisibles en el menú.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiUnprocessableEntityResponse({ description: 'La categoría tiene subcategorías o elementos' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.deleteCategory.execute({ id, actorId: user.sub });
  }
}
