import { describe, expect, it } from 'vitest';
import { readSignals } from './live';
import type { AgendaSignal } from './types';

/** Flujo que entrega el texto troceado como llega por la red: a mitad de evento. */
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

describe('lectura del canal de avisos', () => {
  it('reconstruye eventos partidos entre trozos y descarta los ilegibles', async () => {
    const received: AgendaSignal[] = [];
    await readSignals(
      streamOf(
        'id: 1\ndata: {"kind":"appoint',
        'ment","at":"x"}\n\n',
        'data: no-es-json\n\n',
        'id: 2\ndata: {"kind":"change-request","status":"PENDING","mine":true,"at":"y"}\n\n',
      ),
      (signal) => received.push(signal),
    );

    expect(received).toEqual([
      { kind: 'appointment', at: 'x' },
      { kind: 'change-request', status: 'PENDING', mine: true, at: 'y' },
    ]);
  });
});
