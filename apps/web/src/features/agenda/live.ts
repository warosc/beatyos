'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { MY_DAY_KEY } from '@/features/stylist-day/use-my-day';
import type { AgendaSignal } from './types';
import { AGENDA_KEY } from './use-agenda';
import { renewSession } from '@/lib/session-fetch';

/**
 * Lee un flujo `text/event-stream` y entrega cada evento ya interpretado.
 *
 * No se usa `EventSource` porque no deja reaccionar a un 401: cuando el token caduca —cada
 * quince minutos— se cierra para siempre. Con `fetch` se renueva la sesión y se vuelve a
 * conectar, que es lo que necesita una agenda abierta todo el día en el mostrador.
 */
export async function readSignals(
  body: ReadableStream<Uint8Array>,
  onSignal: (signal: AgendaSignal) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          onSignal(JSON.parse(data) as AgendaSignal);
        } catch {
          /* Un evento ilegible no tumba el canal. */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/**
 * Muestra un aviso del sistema si la persona lo permitió.
 *
 * Se usa el service worker cuando lo hay: así el aviso sale también con la pestaña en
 * segundo plano y, en el móvil con la app instalada, aparece como el de cualquier otra app.
 */
export async function notify(title: string, body: string, url = '/agenda') {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `${title}-${body}`,
        data: { url },
      });
      return;
    }
    new Notification(title, { body, icon: '/icons/icon-192.png' });
  } catch {
    /* Sin avisos del sistema la agenda sigue funcionando: el contador del menú está ahí. */
  }
}

/**
 * Mantiene abierto el canal de avisos mientras haya sesión.
 *
 * Al recibir un aviso refresca lo que corresponda —la agenda, «Mi día», el contador de
 * cambios— y, si es algo que espera a esta persona, muestra un aviso del sistema: a la
 * encargada, «Sara pide mover una cita»; a la profesional, «te aprobaron el cambio».
 */
export function useAgendaLive({
  enabled,
  approver,
  stylist,
}: {
  enabled: boolean;
  approver: boolean;
  stylist: boolean;
}) {
  const queryClient = useQueryClient();
  const roles = useRef({ approver, stylist });
  useEffect(() => {
    roles.current = { approver, stylist };
  }, [approver, stylist]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Varias llegadas seguidas —recordatorios en lote, una aprobación que mueve una cita—
    // se agrupan en un solo refresco.
    let pending: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
        void queryClient.invalidateQueries({ queryKey: MY_DAY_KEY });
      }, 300);
    };

    const onSignal = (signal: AgendaSignal) => {
      attempt = 0;
      if (signal.kind === 'ping') return;
      refresh();
      if (signal.kind !== 'change-request') return;
      if (roles.current.approver && signal.status === 'PENDING') {
        void notify('Cambio de cita por aprobar', 'Una profesional pide mover una cita.');
      }
      if (roles.current.stylist && signal.mine && signal.status === 'APPROVED') {
        void notify(
          'Cambio aprobado',
          'La encargada movió tu cita a la hora que pediste.',
          '/mi-dia',
        );
      }
      if (roles.current.stylist && signal.mine && signal.status === 'REJECTED') {
        void notify(
          'Cambio no aprobado',
          'Tu cita se queda como estaba. Mira el motivo.',
          '/mi-dia',
        );
      }
    };

    const connect = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        let response = await fetch('/api/agenda/stream', {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'text/event-stream' },
        });
        if (response.status === 401) {
          // Con la renovación compartida, nunca con una propia: tras un despliegue todas las
          // pestañas reconectan a la vez, y cada una renovando por su lado presentaría el
          // mismo refresh token dos veces —la API lo toma por un robo y cierra la sesión—.
          // Si el servicio falla al renovar, lanza y se reintenta más tarde.
          if (!(await renewSession())) return; // Sin sesión no hay canal; la app ya lleva al login.
          response = await fetch('/api/agenda/stream', {
            signal: controller.signal,
            cache: 'no-store',
            headers: { Accept: 'text/event-stream' },
          });
        }
        if (response.status === 403) return; // Sin permiso de agenda: nada que escuchar.
        if (response.ok && response.body) {
          // Al reconectar puede haberse perdido algo: se refresca por si acaso.
          if (attempt > 0) refresh();
          await readSignals(response.body, onSignal);
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      // Se cortó (reinicio de la API, red del móvil): se reintenta con espera creciente.
      attempt += 1;
      timer = setTimeout(() => void connect(), Math.min(30_000, 1_000 * 2 ** attempt));
    };

    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(pending);
    };
  }, [enabled, queryClient]);
}
