import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/infrastructure/config/env.schema';
import { CatalogModule } from '../catalog/catalog.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  BlockStylistTimeUseCase,
  ChangeAppointmentStatusUseCase,
  GetAgendaShiftsUseCase,
  GetAppointmentUseCase,
  GetAvailabilityUseCase,
  GetCalendarUseCase,
  RemoveStylistBlockUseCase,
  RescheduleAppointmentUseCase,
  ScheduleAppointmentUseCase,
  SearchAppointmentsUseCase,
  UpdateAppointmentNotesUseCase,
} from './application/appointment.use-cases';
import {
  ApproveChangeRequestUseCase,
  ListChangeRequestsUseCase,
  RejectChangeRequestUseCase,
  RequestAppointmentChangeUseCase,
  WithdrawChangeRequestUseCase,
} from './application/change-request.use-cases';
import {
  PrepareManualReminderUseCase,
  PublicAppointmentLinkUseCase,
  SendDueRemindersUseCase,
} from './application/reminder.use-cases';
import {
  AGENDA_DIRECTORY,
  AGENDA_EVENTS,
  REMINDER_LOG,
  REMINDER_SENDER,
  REMINDER_SETTINGS,
  type ReminderSender,
  type ReminderSettings,
} from './domain/agenda.ports';
import { APPOINTMENT_REPOSITORY } from './domain/appointment.repository';
import { CHANGE_REQUEST_REPOSITORY } from './domain/change-request.repository';
import { AgendaController } from './infrastructure/http/agenda.controller';
import { AppointmentsController } from './infrastructure/http/appointments.controller';
import { PublicAppointmentLinkController } from './infrastructure/http/public-appointment-link.controller';
import { PrismaAgendaDirectory } from './infrastructure/persistence/prisma-agenda-directory';
import { PrismaAppointmentRepository } from './infrastructure/persistence/prisma-appointment.repository';
import { PrismaChangeRequestRepository } from './infrastructure/persistence/prisma-change-request.repository';
import { PrismaReminderLog } from './infrastructure/persistence/prisma-reminder-log';
import { InMemoryAgendaEvents } from './infrastructure/realtime/in-memory-agenda-events';
import { ReminderScheduler } from './infrastructure/reminders/reminder-scheduler';
import {
  LoggingReminderSender,
  TwilioReminderSender,
} from './infrastructure/reminders/reminder-senders';

@Module({
  imports: [CatalogModule, StylistsModule],
  controllers: [AppointmentsController, AgendaController, PublicAppointmentLinkController],
  providers: [
    ScheduleAppointmentUseCase,
    RescheduleAppointmentUseCase,
    ChangeAppointmentStatusUseCase,
    SearchAppointmentsUseCase,
    GetAppointmentUseCase,
    GetAvailabilityUseCase,
    GetCalendarUseCase,
    GetAgendaShiftsUseCase,
    BlockStylistTimeUseCase,
    RemoveStylistBlockUseCase,
    UpdateAppointmentNotesUseCase,
    RequestAppointmentChangeUseCase,
    ListChangeRequestsUseCase,
    ApproveChangeRequestUseCase,
    RejectChangeRequestUseCase,
    WithdrawChangeRequestUseCase,
    SendDueRemindersUseCase,
    PrepareManualReminderUseCase,
    PublicAppointmentLinkUseCase,
    ReminderScheduler,
    InMemoryAgendaEvents,
    { provide: AGENDA_EVENTS, useExisting: InMemoryAgendaEvents },
    { provide: APPOINTMENT_REPOSITORY, useClass: PrismaAppointmentRepository },
    { provide: AGENDA_DIRECTORY, useClass: PrismaAgendaDirectory },
    { provide: CHANGE_REQUEST_REPOSITORY, useClass: PrismaChangeRequestRepository },
    { provide: REMINDER_LOG, useClass: PrismaReminderLog },
    {
      provide: REMINDER_SETTINGS,
      useFactory: (config: ConfigService<Env, true>): ReminderSettings => ({
        // En la suite de tests no corre el planificador: un temporizador vivo entre tests
        // solo produce envíos que nadie espera.
        // Y sin proveedor tampoco: con el canal `log` no sale nada, y marcar las citas como
        // recordadas haría creer a recepción que la clienta fue avisada.
        enabled:
          config.get('REMINDERS_ENABLED', { infer: true }) &&
          config.get('REMINDER_CHANNEL', { infer: true }) !== 'log' &&
          config.get('NODE_ENV', { infer: true }) !== 'test',
        leadHours: config.get('REMINDER_LEAD_HOURS', { infer: true }),
        minimumLeadMinutes: config.get('REMINDER_MIN_LEAD_MINUTES', { infer: true }),
        publicWebUrl: config.get('PUBLIC_WEB_URL', { infer: true }),
        defaultCountryCode: config.get('DEFAULT_PHONE_COUNTRY_CODE', { infer: true }),
        timeZone: config.get('DEFAULT_TIMEZONE', { infer: true }),
      }),
      inject: [ConfigService],
    },
    {
      /**
       * Canal de los recordatorios. Por defecto, el registro: elegir proveedor de mensajería
       * tiene coste por mensaje y es decisión del despliegue, no del código. Con
       * `REMINDER_CHANNEL=whatsapp` o `sms` salen por Twilio.
       */
      provide: REMINDER_SENDER,
      useFactory: (config: ConfigService<Env, true>): ReminderSender => {
        const channel = config.get('REMINDER_CHANNEL', { infer: true });
        if (channel === 'log') return new LoggingReminderSender();
        return new TwilioReminderSender(channel === 'whatsapp' ? 'WHATSAPP' : 'SMS', {
          accountSid: config.get('TWILIO_ACCOUNT_SID', { infer: true }),
          authToken: config.get('TWILIO_AUTH_TOKEN', { infer: true }),
          from: config.get('TWILIO_FROM', { infer: true }),
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [APPOINTMENT_REPOSITORY],
})
export class AppointmentsModule {}
