import { Module } from '@nestjs/common';

import { ReportsModule } from '../reports/reports.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  CreateGoalUseCase,
  DeleteGoalUseCase,
  SearchGoalsWithProgressUseCase,
} from './application/goal.use-cases';
import { GOAL_REPOSITORY } from './domain/goal.repository';
import { GoalsController } from './infrastructure/http/goals.controller';
import { PrismaGoalRepository } from './infrastructure/persistence/prisma-goal.repository';

/**
 * Modulo de metas e incentivos.
 *
 * Importa `ReportsModule` por su `ReportingRepository`: el progreso de una meta se calcula
 * sumando las mismas lineas de venta que ya usa `stylistPerformance`, no un pipeline propio
 * (ADR-0015). Importa `StylistsModule` para resolver el ambito `.own` -que profesional es
 * quien ha iniciado sesion- exactamente igual que lo hace `AppointmentsController`.
 */
@Module({
  imports: [ReportsModule, StylistsModule],
  controllers: [GoalsController],
  providers: [
    CreateGoalUseCase,
    SearchGoalsWithProgressUseCase,
    DeleteGoalUseCase,
    { provide: GOAL_REPOSITORY, useClass: PrismaGoalRepository },
  ],
})
export class GoalsModule {}
