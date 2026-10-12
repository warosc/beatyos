import { Controller, Get, Inject, Param, Sse, type MessageEvent } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { filter, interval, map, merge, type Observable } from 'rxjs';

import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import { Public } from '../../../../shared/infrastructure/http/decorators';
import { InMemoryAgendaEvents } from '../../../appointments/infrastructure/realtime/in-memory-agenda-events';
import {
  displayTokenDigest,
  GetQueueDisplayUseCase,
} from '../../application/queue-board.use-cases';
import {
  QUEUE_DISPLAY_LINKS,
  type QueueDisplayLinks,
  type QueueDisplaySalon,
} from '../../domain/queue.ports';
import { QueueDisplayResponse } from './queue.dto';

/** Latido del canal: mantiene viva la conexión a través de Cloudflare y del proxy web. */
const HEARTBEAT_MS = 25_000;

/**
 * Pantalla de turnos de la sala (ADR-0024): la TV del salón, sin cuenta ni contraseña.
 *
 * El enlace **es** la credencial, y solo sirve para mirar: quién está llamada, con quién y
 * cuántas esperan. No permite anotar, llamar ni ver datos de la clienta más allá del nombre
 * corto. El salón se averigua por el propio enlace, y a partir de ahí todo corre dentro de
 * él con el aislamiento normal.
 */
@ApiTags('Pantalla de turnos')
@Controller({ path: 'public/queue-display', version: '1' })
export class PublicQueueDisplayController {
  constructor(
    private readonly display: GetQueueDisplayUseCase,
    private readonly events: InMemoryAgendaEvents,
    @Inject(QUEUE_DISPLAY_LINKS) private readonly links: QueueDisplayLinks,
  ) {}

  private async salonFor(token: string): Promise<QueueDisplaySalon> {
    // Un enlace mal formado ni siquiera se busca: no hay enlace válido de otra longitud.
    const salon =
      /^[A-Za-z0-9_-]{16,64}$/.test(token) &&
      (await this.links.findSalonByDigest(displayTokenDigest(token)));
    if (!salon) throw new EntityNotFoundError('Pantalla de turnos', 'enlace no válido');
    return salon;
  }

  @Get(':token')
  @Public()
  @ApiOperation({ summary: 'Lo que muestra la pantalla: llamadas y fila' })
  @ApiOkResponse({ type: QueueDisplayResponse })
  @ApiNotFoundResponse({ description: 'El enlace no existe o se sustituyó por otro' })
  async view(@Param('token') token: string): Promise<QueueDisplayResponse> {
    const salon = await this.salonFor(token);
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
  @ApiOperation({ summary: 'Avisos en vivo de la fila para la pantalla (text/event-stream)' })
  async stream(@Param('token') token: string): Promise<Observable<MessageEvent>> {
    const salon = await this.salonFor(token);
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
