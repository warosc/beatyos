import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Subject, filter, type Observable } from 'rxjs';

import type { AgendaEvent, AgendaEvents } from '../../domain/agenda.ports';

/**
 * Bus de avisos de la agenda dentro del proceso.
 *
 * Basta con una sola réplica de la API, que es como se despliega hoy. Con varias, cada
 * réplica solo vería lo que pasa por ella y el aviso llegaría a medias: el sustituto es
 * el mismo puerto sobre Redis pub/sub, igual que el rate limiting (ADR-0007). Mientras
 * tanto la interfaz vuelve a pedir la agenda cada minuto, así que un aviso perdido se
 * nota como un retraso, no como un dato que falta.
 */
@Injectable()
export class InMemoryAgendaEvents implements AgendaEvents, OnModuleDestroy {
  private readonly subject = new Subject<AgendaEvent>();

  publish(event: AgendaEvent): void {
    this.subject.next(event);
  }

  /** Avisos de un salón. Nunca los de otro: el filtro por inquilino vive aquí, una vez. */
  forTenant(tenantId: string): Observable<AgendaEvent> {
    return this.subject.asObservable().pipe(filter((event) => event.tenantId === tenantId));
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
