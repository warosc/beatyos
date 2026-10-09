import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { reminderWindow, SendDueRemindersUseCase } from '../../application/reminder.use-cases';
import {
  REMINDER_LOG,
  REMINDER_SETTINGS,
  type ReminderLog,
  type ReminderSettings,
} from '../../domain/agenda.ports';

/** Cada cuánto se buscan recordatorios pendientes. */
const SCAN_INTERVAL_MS = 5 * 60_000;

/**
 * Planificador de recordatorios.
 *
 * Un temporizador dentro del proceso, sin cola ni cron externo: con una sola réplica es
 * suficiente, y una pasada perdida por un reinicio se recupera en la siguiente porque la
 * marca de «recordada» vive en la cita, no en memoria. Con varias réplicas habría que
 * elegir una —o pasar a una cola— para no enviar dos veces el mismo mensaje.
 *
 * Cada salón se procesa **dentro de su propio contexto**: el planificador solo cruza
 * salones para saber cuáles tienen trabajo, y el envío corre con el aislamiento normal.
 */
@Injectable()
export class ReminderScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReminderScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sendDue: SendDueRemindersUseCase,
    @Inject(REMINDER_LOG) private readonly log: ReminderLog,
    @Inject(REMINDER_SETTINGS) private readonly settings: ReminderSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.settings.enabled) {
      this.logger.log('Recordatorios automáticos desactivados (REMINDERS_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), SCAN_INTERVAL_MS);
    // `unref`: el temporizador no debe impedir que el proceso termine.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Una pasada por todos los salones. Pública para poder probarla sin esperar. */
  async tick(): Promise<void> {
    // Si una pasada tarda más que el intervalo, la siguiente no se solapa con ella.
    if (this.running) return;
    this.running = true;
    try {
      const window = reminderWindow(this.clock.now(), this.settings);
      const tenants = await RequestContextStore.run({}, () => this.log.tenantsWithDue(window));
      for (const tenantId of tenants) {
        await RequestContextStore.run({ tenantId }, () => this.sendDue.execute()).catch(
          (error: unknown) =>
            // Un salón con un problema no puede dejar sin recordatorios a los demás.
            this.logger.error(
              `Fallo al enviar recordatorios del salón ${tenantId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
        );
      }
    } catch (error) {
      this.logger.error(
        `Fallo en la pasada de recordatorios: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
