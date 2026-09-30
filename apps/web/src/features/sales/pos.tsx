'use client';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAccess } from '@/components/session-access';
import { CASH_KEY, fetchCurrentCash } from '@/features/cash/cash-api';
import { fetchPendingCount, PENDING_COUNT_KEY, problem } from '@/features/service-tickets/types';
import { loadOptions } from '@/lib/pagination';
import { sessionFetch } from '@/lib/session-fetch';
import { addItem, cartTotals, toCents, toSaleLines, type CartLine, type SaleItem } from './cart';
import { CartPanel, type Notice } from './cart-panel';
import { CatalogPanel, FREQUENT_KEY } from './catalog-panel';
import type { PosClient } from './client-combobox';
import { recordSale } from './frequent-items';
import { PaymentDialog, type ConfirmPayments } from './payment-dialog';
import { SaleComplete } from './sale-complete';
import { SaleDialog } from './sale-dialog';
import { SalesTabs } from './sales-tabs';
import type { Sale } from './types';
import type { PosStylist } from './stylist-select';
import { usePosShortcuts } from './use-shortcuts';

type Completed = {
  sale: Sale;
  totalCents: number;
  changeCents: number;
  tenderedCents: number;
};

/**
 * Punto de venta.
 *
 * Aquí se cobra lo que llega al mostrador sin comanda: productos y servicios sueltos. Los
 * servicios que registran las estilistas se cobran en Caja; esta pantalla solo avisa de que
 * hay alguno esperando.
 */
export function Pos() {
  const qc = useQueryClient();
  const { can } = useAccess();
  const searchRef = useRef<HTMLInputElement>(null);
  const [lines, setLinesState] = useState<CartLine[]>([]);
  // La cuenta más reciente, también entre dos renders: dos artículos agregados seguidos —o
  // uno que llega de una búsqueda aún en curso— no deben pisarse con una copia vieja.
  const latestLines = useRef<CartLine[]>([]);
  const setLines = (next: CartLine[]) => {
    latestLines.current = next;
    setLinesState(next);
  };
  const [client, setClient] = useState<PosClient | null>(null);
  // `undefined` mientras nadie lo ha elegido: entonces atiende quien cobra, si es estilista.
  const [chosenStylist, setChosenStylist] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [paying, setPaying] = useState(false);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [printing, setPrinting] = useState(false);

  const canCharge = can('invoices.create', 'payments.create');
  const canChooseStylist = can('stylists.read');
  const canReadCash = can('cash.read');

  const myStylist = useQuery({
    queryKey: ['my-stylist'],
    queryFn: async () => {
      const response = await sessionFetch('/api/stylists/me');
      const body = (await response.json()) as { data: PosStylist | null };
      return body.data;
    },
  });
  const stylists = useQuery({
    queryKey: ['pos-stylists'],
    enabled: canChooseStylist,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      loadOptions<PosStylist>('/api/agenda?resource=stylists&status=ACTIVE&sort=name:asc', signal),
  });
  const cash = useQuery({ queryKey: CASH_KEY, enabled: canReadCash, queryFn: fetchCurrentCash });
  // La misma consulta que el aviso del menú: comparten caché y no se pide dos veces.
  const pendingTickets = useQuery({
    queryKey: PENDING_COUNT_KEY,
    enabled: can('service-tickets.read'),
    refetchInterval: 30_000,
    queryFn: fetchPendingCount,
  });

  const cashOpen = canReadCash && cash.isSuccess ? cash.data != null : null;
  // Una estilista sin permiso para ver al equipo cobra a su nombre, como hasta ahora.
  const lineStylist = canChooseStylist
    ? chosenStylist === undefined
      ? (myStylist.data?.id ?? null)
      : chosenStylist
    : (myStylist.data?.id ?? null);

  function add(item: SaleItem) {
    const result = addItem(latestLines.current, item, lineStylist);
    setLines(result.lines);
    setNotice(result.error ? { kind: 'error', text: result.error } : null);
  }

  function openPayment() {
    if (!canCharge || !lines.length || paying || completed) return;
    setNotice(null);
    setPaying(true);
  }

  usePosShortcuts({ onSearch: () => searchRef.current?.focus(), onCharge: openPayment });

  const confirm: ConfirmPayments = async (payments, changeCents) => {
    const response = await sessionFetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: client?.id, lines: toSaleLines(lines), payments }),
    });
    if (!response.ok) return problem(response, 'No pudimos procesar la venta.');

    const { data } = (await response.json()) as { data: Sale };
    recordSale(lines.map((line) => line.item));
    setPaying(false);
    // Lo entregado en efectivo es lo cobrado en efectivo más el vuelto. Solo existe ahora:
    // la API no lo guarda, así que solo el comprobante del momento lo muestra.
    const cashCents = payments
      .filter((payment) => payment.method === 'CASH')
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);
    setCompleted({
      sale: { ...data, clientName: client?.fullName ?? null },
      totalCents: toCents(data.total),
      changeCents,
      tenderedCents: changeCents > 0 ? cashCents + changeCents : 0,
    });
    setLines([]);
    setClient(null);
    // Solo lo que la venta ha cambiado: existencias, caja y atajos. Volver a pedir todo el
    // catálogo y todas las clientas tras cada cobro era lo que hacía lenta la pantalla.
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['pos-catalog'] }),
      qc.invalidateQueries({ queryKey: CASH_KEY }),
      qc.invalidateQueries({ queryKey: FREQUENT_KEY }),
    ]);
    return null;
  };

  function nextSale() {
    setCompleted(null);
    setPrinting(false);
    // Tras cerrar el diálogo, que devuelve el foco a donde estaba: la venta siguiente
    // empieza escribiendo.
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  const pending = pendingTickets.data ?? 0;

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-8.25rem)]">
      <SalesTabs />
      {pending > 0 && (
        <Link
          href="/caja"
          className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm hover:bg-primary/10"
        >
          <BellRing size={16} className="shrink-0 text-primary" />
          <span>
            {pending === 1
              ? 'Hay 1 servicio de estilista por cobrar.'
              : `Hay ${pending} servicios de estilistas por cobrar.`}
          </span>
          <strong className="ml-auto text-primary">Ir a Caja →</strong>
        </Link>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <CatalogPanel onAdd={add} searchRef={searchRef} />
        <CartPanel
          lines={lines}
          onLines={setLines}
          stylists={canChooseStylist ? (stylists.data ?? []) : null}
          defaultStylistId={lineStylist}
          onDefaultStylist={setChosenStylist}
          client={client}
          onClient={setClient}
          canChooseClient={can('clients.read')}
          canDiscount={can('invoices.discount')}
          canCharge={canCharge}
          cashOpen={cashOpen}
          notice={notice}
          onNotice={setNotice}
          onCharge={openPayment}
        />
      </div>

      {paying && (
        <PaymentDialog
          title="Cobrar venta"
          subtitle={`${client?.fullName ?? 'Cliente ocasional'} · ${lines.length} ${lines.length === 1 ? 'línea' : 'líneas'}`}
          totalCents={cartTotals(lines).totalCents}
          cashOpen={cashOpen}
          onClose={() => setPaying(false)}
          onConfirm={confirm}
        />
      )}
      {completed && !printing && (
        <SaleComplete
          number={completed.sale.number}
          totalCents={completed.totalCents}
          changeCents={completed.changeCents}
          onPrint={() => setPrinting(true)}
          onNext={nextSale}
        />
      )}
      {completed && printing && (
        <SaleDialog
          saleId={completed.sale.id}
          initial={completed.sale}
          cash={{ tenderedCents: completed.tenderedCents, changeCents: completed.changeCents }}
          closeLabel="Nueva venta"
          onClose={nextSale}
        />
      )}
    </div>
  );
}
