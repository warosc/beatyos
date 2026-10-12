import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock, type UseCase } from '../../../shared/application/ports';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import type { Stylist } from '../../stylists/domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import { resolveQueuePeriod, summarizeQueue, type QueueStats } from '../domain/queue-stats';
import { businessDateOf } from '../domain/queue-turn.entity';
import {
  QUEUE_SETTINGS,
  QUEUE_STATS_READER,
  type QueueSettings,
  type QueueStatsReader,
} from '../domain/queue.ports';

/** Sin fechas, el último mes: lo bastante para ver la forma de la semana. */
const DEFAULT_DAYS = 30;

export interface GetQueueStatsInput {
  /** Días del salón (`AAAA-MM-DD`), ambos incluidos. */
  readonly from?: string | null;
  readonly to?: string | null;
}

export interface QueueStatsView {
  readonly stats: QueueStats;
  readonly stylistNames: ReadonlyMap<string, string>;
  readonly serviceNames: ReadonlyMap<string, string>;
}

/**
 * Indicadores de la fila para la propietaria (ADR-0025): cuánto esperan, cuántas se van,
 * cuándo hay más gente y cuánto deja la clienta sin cita.
 */
@Injectable()
export class GetQueueStatsUseCase implements UseCase<GetQueueStatsInput, QueueStatsView> {
  constructor(
    @Inject(QUEUE_STATS_READER) private readonly reader: QueueStatsReader,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(QUEUE_SETTINGS) private readonly settings: QueueSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: GetQueueStatsInput): Promise<QueueStatsView> {
    const today = businessDateOf(this.clock.now(), this.settings.timeZone);
    const period = resolveQueuePeriod({
      from: input.from,
      to: input.to,
      today,
      fallbackDays: DEFAULT_DAYS,
    });

    const stats = summarizeQueue(await this.reader.factsBetween(period.from, period.to), {
      period,
      today,
      timeZone: this.settings.timeZone,
      currency: this.settings.currency,
    });

    const stylistIds = stats.byStylist.map((stylist) => stylist.stylistId);
    const [stylists, services] = await Promise.all([
      // Un salón tiene un puñado de profesionales: no justifica un `findManyByIds` propio.
      Promise.all(stylistIds.map((id) => this.stylists.findById(id))),
      this.services.findManyByIds(stats.byService.map((service) => service.serviceId)),
    ]);

    return {
      stats,
      stylistNames: new Map(
        stylists
          .filter((stylist): stylist is Stylist => stylist !== null)
          .map((stylist) => [stylist.id, stylist.displayName]),
      ),
      serviceNames: new Map(services.map((service) => [service.id, service.name])),
    };
  }
}
