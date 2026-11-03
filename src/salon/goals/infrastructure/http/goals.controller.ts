import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../../stylists/domain/stylist.repository';
import {
  CreateGoalUseCase,
  DeleteGoalUseCase,
  SearchGoalsWithProgressUseCase,
  type GoalWithProgress,
} from '../../application/goal.use-cases';
import { CreateGoalDto, GoalQueryDto, GoalResponse } from './goal.dto';

/**
 * Adaptador HTTP de metas e incentivos.
 *
 * Igual que la agenda (ADR-0006), es un recurso con ámbito por filas: quien tiene
 * `goals.read` ve las de todo el equipo, quien solo tiene `goals.read.own` ve
 * exclusivamente las suyas. El progreso se resuelve en el caso de uso, no aquí — este
 * controlador solo traduce petición y respuesta.
 */
@ApiTags('Metas e incentivos')
@Controller({ path: 'goals', version: '1' })
export class GoalsController {
  constructor(
    private readonly createGoal: CreateGoalUseCase,
    private readonly searchGoals: SearchGoalsWithProgressUseCase,
    private readonly deleteGoal: DeleteGoalUseCase,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
  ) {}

  private async ownScopeFor(user: AccessTokenClaims): Promise<string | null> {
    const permissions = new Set(user.permissions);
    if (permissions.has(WILDCARD_PERMISSION) || permissions.has(PERMISSIONS.goals.read)) {
      return null;
    }
    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist?.id ?? '__sin_ficha_profesional__';
  }

  @Post()
  @RequirePermissions(PERMISSIONS.goals.create)
  @ApiOperation({ summary: 'Define una meta de facturación para una profesional' })
  @ApiCreatedResponse({ type: GoalResponse })
  async create(
    @Body() dto: CreateGoalDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<GoalResponse> {
    const created = await this.createGoal.execute({
      tenantId: user.tenantId!,
      stylistId: dto.stylistId,
      metric: dto.metric,
      targetAmount: dto.targetAmount.toFixed(2),
      currency: 'GTQ',
      periodStart: new Date(dto.periodStart),
      periodEnd: new Date(dto.periodEnd),
      rewardDescription: dto.rewardDescription,
      actorId: user.sub,
    });

    return present(created, await this.namesFor([created]));
  }

  @Get()
  @RequireAnyPermission(PERMISSIONS.goals.read, PERMISSIONS.goals.readOwn)
  @ApiOperation({
    summary: 'Lista metas con su progreso ya calculado',
    description:
      'Con `goals.read` se ve el equipo completo. Con `goals.read.own` solo las propias, y ' +
      'el filtro se impone en el servidor: enviar `stylistId` de otra persona no amplía el ' +
      'alcance.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/GoalResponse' } },
        meta: { $ref: '#/components/schemas/PageMetaResponse' },
      },
    },
  })
  async list(
    @Query() query: GoalQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ data: GoalResponse[]; meta: PageMetaResponse }> {
    const page = await this.searchGoals.execute({
      filter: { stylistId: query.stylistId, metric: query.metric },
      page: query.toPageRequest(),
      restrictToStylistId: await this.ownScopeFor(user),
    });

    const names = await this.namesFor(page.data);
    return { data: page.data.map((item) => present(item, names)), meta: page.meta };
  }

  /** Nombres de las profesionales de las metas, también de las dadas de baja (ADR-0028). */
  private async namesFor(items: readonly GoalWithProgress[]): Promise<Map<string, string>> {
    const ids = [...new Set(items.map((item) => item.goal.stylistId))];
    const found = await Promise.all(
      ids.map((id) => this.stylists.findById(id, { includeDeleted: true })),
    );
    return new Map(
      found
        .filter((stylist) => stylist !== null)
        .map((stylist) => [stylist.id, stylist.historyName]),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.goals.delete)
  @ApiOperation({ summary: 'Cancela una meta (baja lógica)' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.deleteGoal.execute({ goalId: id, actorId: user.sub });
  }
}

// ---------------------------------------------------------------------------

const present = (item: GoalWithProgress, names: ReadonlyMap<string, string>): GoalResponse => ({
  id: item.goal.id,
  stylistId: item.goal.stylistId,
  stylistName: names.get(item.goal.stylistId) ?? 'Profesional',
  metric: item.goal.metric,
  targetAmount: item.goal.targetAmount.toDecimalString(),
  progress: item.progress.toDecimalString(),
  percentage: item.percentage,
  currency: item.goal.targetAmount.currency,
  periodStart: item.goal.periodStart.toISOString(),
  periodEnd: item.goal.periodEnd.toISOString(),
  rewardDescription: item.goal.rewardDescription,
  status: item.goal.statusAt(new Date()),
  achievedAt: item.goal.achievedAt?.toISOString() ?? null,
  createdAt: item.goal.audit.createdAt.toISOString(),
});
