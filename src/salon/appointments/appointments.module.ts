import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  ScheduleAppointmentUseCase,
  RescheduleAppointmentUseCase,
  ChangeAppointmentStatusUseCase,
  SearchAppointmentsUseCase,
  GetAppointmentUseCase,
  GetAvailabilityUseCase,
  GetCalendarUseCase,
} from './application/appointment.use-cases';
import { APPOINTMENT_REPOSITORY } from './domain/appointment.repository';
import { AppointmentsController } from './infrastructure/http/appointments.controller';
import { PrismaAppointmentRepository } from './infrastructure/persistence/prisma-appointment.repository';

@Module({
  imports: [CatalogModule, StylistsModule],
  controllers: [AppointmentsController],
  providers: [
    ScheduleAppointmentUseCase,
    RescheduleAppointmentUseCase,
    ChangeAppointmentStatusUseCase,
    SearchAppointmentsUseCase,
    GetAppointmentUseCase,
    GetAvailabilityUseCase,
    GetCalendarUseCase,
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
  ],
  exports: [APPOINTMENT_REPOSITORY],
})
export class AppointmentsModule {}
