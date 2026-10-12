'use client';
import type { QueueTurn } from './types';

/**
 * Ticket del turno para la clienta, en columna de impresora de tickets.
 *
 * Usa la misma `print-area` que el comprobante de venta: al imprimir solo sale esto. Lleva
 * el número bien grande —es lo que la clienta mira cuando suena la pantalla— y nada de
 * datos que no necesite: ni teléfono ni ficha.
 */
export function QueueTicket({ turn, salonName }: { turn: QueueTurn; salonName: string }) {
  const issued = new Date(turn.createdAt).toLocaleString('es-GT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="print-area mx-auto w-full max-w-[80mm] bg-white p-4 text-center font-mono text-[12px] leading-snug text-black">
      <p className="text-sm font-bold">{salonName}</p>
      <p className="mt-2 border-y border-dashed border-black py-1">TU TURNO</p>
      <p className="my-2 text-6xl font-bold tabular-nums">{turn.number}</p>
      <p className="font-bold">{turn.clientName}</p>
      {turn.serviceNames.length > 0 && <p>{turn.serviceNames.join(' · ')}</p>}
      {turn.preferredStylistName && <p>Con {turn.preferredStylistName}</p>}
      {turn.position && (
        <p className="mt-1">
          {turn.position === 1 ? 'Eres la siguiente' : `Hay ${turn.position - 1} antes que tú`}
        </p>
      )}
      <p className="mt-2 border-t border-dashed border-black pt-1 text-[10px]">
        {issued} · Te llamaremos en la pantalla
      </p>
    </div>
  );
}
