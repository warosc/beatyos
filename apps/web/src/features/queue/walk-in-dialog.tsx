'use client';
import { Check, Printer, Search, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import type { Service } from '@/features/agenda/types';
import { ClientCombobox, type PosClient } from '@/features/sales/client-combobox';
import { canPerform, type PosStylist } from '@/features/sales/stylist-select';
import { cn } from '@/lib/utils';
import { QueueTicket } from './queue-ticket';
import { queueSend, type QueueTurn } from './types';

/**
 * Recepción anota a una clienta que llega sin cita (ADR-0024).
 *
 * Lo mínimo para no hacer esperar en el mostrador: quién es —con ficha o solo el nombre—,
 * qué quiere si ya lo sabe y si pide a alguien. Al guardar enseña el número en grande y
 * deja imprimir el ticket.
 */
export function WalkInDialog({
  services,
  stylists,
  salonName,
  onClose,
  onSaved,
}: {
  services: readonly Service[];
  stylists: readonly PosStylist[];
  salonName: string;
  onClose: () => void;
  onSaved: (turn: QueueTurn) => void;
}) {
  const { can } = useAccess();
  const [client, setClient] = useState<PosClient | null>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preferred, setPreferred] = useState('');
  const [notes, setNotes] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<QueueTurn | null>(null);

  const offered = services.filter((service) => service.isBookable);
  const shown = offered.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const hasClient = !!client || name.trim().length > 1;
  // Solo se puede pedir a quien hace todo lo marcado: si no, esperaría a alguien que no
  // la puede atender. La API lo vuelve a comprobar.
  const able = (stylist: PosStylist) => [...picked].every((id) => canPerform(stylist, id));

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    const chosen = stylists.find((stylist) => stylist.id === preferred);
    if (chosen && ![...next].every((serviceId) => canPerform(chosen, serviceId))) setPreferred('');
  }

  function reset() {
    setClient(null);
    setName('');
    setPicked(new Set());
    setPreferred('');
    setNotes('');
    setSaved(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !hasClient) return;
    setBusy(true);
    setError('');
    const outcome = await queueSend<QueueTurn>(
      '/api/queue',
      {
        clientId: client?.id,
        clientName: client ? undefined : name.trim(),
        serviceIds: [...picked],
        preferredStylistId: preferred || undefined,
        notes: notes.trim() || undefined,
      },
      'No pudimos anotarla en la fila.',
    );
    setBusy(false);
    if (!outcome.ok) return setError(outcome.error);
    setSaved(outcome.data);
    onSaved(outcome.data);
  }

  if (saved) {
    return (
      <Sheet
        title={`Turno ${saved.number}`}
        description={
          saved.position === 1
            ? `${saved.clientName} es la siguiente.`
            : `${saved.clientName} tiene ${(saved.position ?? 1) - 1} por delante.`
        }
        onClose={onClose}
        footer={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => window.print()}>
              <Printer size={18} />
              Imprimir ticket
            </Button>
            <Button variant="outline" onClick={reset}>
              <UserPlus size={18} />
              Anotar otra
            </Button>
            <Button className="ml-auto" onClick={onClose}>
              Listo
            </Button>
          </div>
        }
      >
        <QueueTicket turn={saved} salonName={salonName} />
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Anotar en la fila"
      description="Para quien llega sin cita. Le toca cuando quede libre alguien que haga lo que pide."
      onClose={onClose}
      size="lg"
      footer={
        <Button form="walk-in" className="h-12 w-full text-base" disabled={busy || !hasClient}>
          <UserPlus size={18} />
          {busy ? 'Anotando…' : 'Anotar en la fila'}
        </Button>
      }
    >
      <form id="walk-in" onSubmit={submit} className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Clienta</h3>
          {can('clients.read') && (
            <ClientCombobox
              value={client}
              onChange={(next) => {
                setClient(next);
                if (next) setName('');
              }}
              label="Buscar clienta"
              placeholder="Buscar clienta por nombre o teléfono"
            />
          )}
          {!client && (
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={150}
              aria-label="Nombre de la clienta"
              placeholder="…o escribe su nombre si no tiene ficha"
              className="h-12 w-full rounded-xl border bg-background px-3"
            />
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Qué quiere <span className="font-normal text-muted-foreground">(si ya lo sabe)</span>
            </h3>
            <span className="text-xs text-muted-foreground">{picked.size} marcados</span>
          </div>
          {offered.length > 10 && (
            <label className="flex h-11 items-center gap-2 rounded-xl border bg-background px-3">
              <Search size={16} className="text-muted-foreground" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                aria-label="Buscar servicio"
                placeholder="Buscar servicio"
                className="w-full bg-transparent outline-none"
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {shown.map((service) => {
              const on = picked.has(service.id);
              return (
                <button
                  key={service.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(service.id)}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm',
                    on ? 'border-primary bg-primary/10 font-semibold' : 'bg-background',
                  )}
                >
                  {on && <Check size={14} />}
                  {service.name}
                </button>
              );
            })}
          </div>
        </section>

        <label className="block text-sm font-semibold">
          Profesional
          <select
            value={preferred}
            onChange={(event) => setPreferred(event.target.value)}
            className="mt-1 h-12 w-full rounded-xl border bg-background px-3 font-normal"
          >
            <option value="">Cualquiera que quede libre</option>
            {stylists.map((stylist) => (
              <option key={stylist.id} value={stylist.id} disabled={!able(stylist)}>
                {stylist.displayName}
                {!able(stylist) ? ' (no hace lo marcado)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm font-semibold">
          Nota <span className="font-normal text-muted-foreground">(opcional)</span>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={300}
            placeholder="Por ejemplo: trae su propio tinte"
            className="mt-1 h-12 w-full rounded-xl border bg-background px-3 font-normal"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
