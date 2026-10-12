import { Controller, Get, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { filter, interval, map, merge, type Observable } from 'rxjs';

import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { Public } from '../../../../shared/infrastructure/http/decorators';
import { InMemoryAgendaEvents } from '../../../appointments/infrastructure/realtime/in-memory-agenda-events';
import { GetQueueDisplayUseCase } from '../../application/queue-board.use-cases';
import type { QueueDisplaySalon } from '../../domain/queue.ports';
import { QueueDisplayResponse } from './queue.dto';
import { DisplaySalon, QueueDisplayTokenGuard } from './queue-display-token.guard';

/** Latido del canal: mantiene viva la conexión a través de Cloudflare y del proxy web. */
const HEARTBEAT_MS = 25_000;

/**
 * Pantalla de turnos de la sala (ADR-0024): la TV del salón, sin cuenta ni contraseña.
 *
 * El enlace **es** la credencial, y solo sirve para mirar: quién está llamada, con quién y
 * cuántas esperan. No permite anotar, llamar ni ver datos de la clienta más allá del nombre
 * corto. El salón lo averigua `QueueDisplayTokenGuard` por el propio enlace, y a partir de ahí
 * todo corre dentro de él con el aislamiento normal.
 */
@ApiTags('Pantalla de turnos')
@Controller({ path: 'public/queue-display', version: '1' })
@UseGuards(QueueDisplayTokenGuard)
export class PublicQueueDisplayController {
  constructor(
    private readonly display: GetQueueDisplayUseCase,
    private readonly events: InMemoryAgendaEvents,
  ) {}

  @Get(':token')
  @Public()
  @ApiParam({ name: 'token', type: String, description: 'Enlace de la pantalla' })
  @ApiOperation({ summary: 'Lo que muestra la pantalla: llamadas y fila' })
  @ApiOkResponse({ type: QueueDisplayResponse })
  @ApiNotFoundResponse({ description: 'El enlace no existe o se sustituyó por otro' })
  async view(@DisplaySalon() salon: QueueDisplaySalon): Promise<QueueDisplayResponse> {
    return QueueDisplayResponse.from(
      await RequestContextStore.runAsTenant(salon.tenantId, () =>
        this.display.execute({ salonName: salon.name }),
      ),
    );
  }

  /**
   * Avisos en vivo de la fila (Server-Sent Events). Como el de la agenda, solo dice que algo
   * cambió: la pantalla vuelve a pedir la vista, que es la que decide qué se enseña.
   */
  @Sse(':token/stream')
  @Public()
  @ApiParam({ name: 'token', type: String, description: 'Enlace de la pantalla' })
  @ApiOperation({ summary: 'Avisos en vivo de la fila para la pantalla (text/event-stream)' })
  @ApiNotFoundResponse({ description: 'El enlace no existe o se sustituyó por otro' })
  stream(@DisplaySalon() salon: QueueDisplaySalon): Observable<MessageEvent> {
    const changes = this.events.forTenant(salon.tenantId).pipe(
      filter((event) => event.kind === 'queue'),
      map((event): MessageEvent => ({ data: { kind: 'queue', at: event.at.toISOString() } })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ data: { kind: 'ping', at: new Date().toISOString() } })),
    );
    return merge(changes, heartbeat);
  }
}
