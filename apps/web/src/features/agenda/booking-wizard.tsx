'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Clock, Search, Sparkles, UserPlus, Users, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { ClientCombobox, type PosClient } from '@/features/sales/client-combobox';
import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';
import { cn, money } from '@/lib/utils';
import { agendaSend } from './api';
import { SlotPicker } from './slot-picker';
import { dayLabel, fold, formatDuration, startOfDay, time } from './time';
import type { Appointment, Service, Slot, StylistShifts } from './types';
import { AGENDA_KEY } from './use-agenda';

type Step = 'client' | 'services' | 'stylist' | 'time' | 'confirm';

const STEP_LABEL: Record<Step, string> = {
  client: 'Clienta',
  services: 'Servicios',
  stylist: 'Profesional',
  time: 'Hora',
  confirm: 'Confirmar',
};

const SOURCES = [
  { value: 'PHONE', label: 'Llamada o WhatsApp' },
  { value: 'WALK_IN', label: 'En el salón' },
  { value: 'STAFF', label: 'Otro' },
] as const;

/**
 * Agendar en un móvil en menos de medio minuto.
 *
 * Un paso por pantalla, con el botón para seguir siempre al alcance del pulgar. El orden
 * es el de la conversación con la clienta: quién eres, qué te quieres hacer, con quién y
 * cuándo. La hora llega al final porque depende de todo lo anterior: la duración la fijan
 * los servicios y los huecos, la profesional.
 */
export function BookingWizard({
  initialClientId,
  initial,
  team,
  services,
  ownStylistId,
  onClose,
  onSaved,
}: {
  initialClientId?: string;
  /** Hueco tocado en la parrilla. */
  initial?: { day?: Date; stylistId?: string; startsAt?: string };
  team: StylistShifts[];
  services: Service[];
  /** Con ámbito propio, la profesional que agenda: no elige con quién. */
  ownStylistId?: string | null;
  onClose: () => void;
  onSaved: (appointment: Appointment) => void;
}) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const locked = ownStylistId !== undefined;
  const steps: Step[] = locked
    ? ['client', 'services', 'time', 'confirm']
    : ['client', 'services', 'stylist', 'time', 'confirm'];

  const [step, setStep] = useState<Step>('client');
  const [client, setClient] = useState<PosClient | null>(null);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [stylistId, setStylistId] = useState<string | null>(
    locked ? (ownStylistId ?? null) : (initial?.stylistId ?? null),
  );
  const [day, setDay] = useState(startOfDay(initial?.day ?? new Date()));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [source, setSource] = useState<(typeof SOURCES)[number]['value']>('PHONE');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Desde la ficha de una clienta se llega con ella ya elegida.
  const preset = useQuery({
    queryKey: ['agenda-client', initialClientId],
    enabled: Boolean(initialClientId),
    queryFn: async () => {
      const response = await sessionFetch(`/api/clients/${encodeURIComponent(initialClientId!)}`);
      if (!response.ok) return null;
      return ((await response.json()) as { data: PosClient }).data;
    },
  });
  const [presetApplied, setPresetApplied] = useState(false);
  if (preset.data && !presetApplied) {
    // Ajuste de estado durante el render, el patrón que React recomienda para derivar
    // estado de un dato que llega: se aplica una sola vez y sin efecto intermedio.
    setPresetApplied(true);
    setClient(preset.data);
    setStep('services');
  }

  const bookable = services.filter((service) => service.isBookable);
  const chosen = serviceIds
    .map((id) => bookable.find((service) => service.id === id))
    .filter((service): service is Service => Boolean(service));
  const totalMinutes = chosen.reduce((sum, service) => sum + service.blockedMinutes, 0);
  const totalPrice = chosen.reduce((sum, service) => sum + Number(service.priceWithTax), 0);

  const names = useMemo(
    () =>
      new Map(team.map((member) => [member.stylistId, { name: member.name, color: member.color }])),
    [team],
  );
  const capable = team.filter(
    (member) =>
      member.isBookable &&
      serviceIds.every((id) => member.serviceIds.length === 0 || member.serviceIds.includes(id)),
  );

  const index = steps.indexOf(step);
  const canContinue =
    (step === 'client' && client !== null) ||
    (step === 'services' && serviceIds.length > 0) ||
    step === 'stylist' ||
    (step === 'time' && slot !== null) ||
    step === 'confirm';

  const go = (target: Step) => {
    setError('');
    setStep(target);
  };

  async function submit() {
    if (!client || !slot) return;
    setBusy(true);
    setError('');
    const result = await agendaSend<Appointment>(
      '/api/agenda',
      'POST',
      {
        clientId: client.id,
        stylistId: slot.stylistId,
        startsAt: slot.startsAt,
        serviceIds,
        source,
        ...(notes.trim() ? { internalNotes: notes.trim() } : {}),
      },
      'No pudimos reservar la cita.',
    );
    setBusy(false);
    if (!result.ok) {
      // Lo más probable es que otra persona haya ocupado el hueco mientras tanto: se
      // vuelve a la hora con los huecos ya actualizados.
      setError(result.error);
      setSlot(null);
      setStep('time');
      await queryClient.invalidateQueries({ queryKey: [...AGENDA_KEY, 'availability'] });
      return;
    }
    onSaved(result.data);
  }

  const footer = (
    <div className="flex items-center gap-2">
      {index > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => go(steps[index - 1])}
          aria-label="Paso anterior"
        >
          <ChevronLeft size={18} />
          Atrás
        </Button>
      )}
      <div className="ml-auto text-right text-xs text-muted-foreground">
        {chosen.length > 0 && (
          <>
            <span className="font-semibold text-foreground">{money(totalPrice)}</span> ·{' '}
            {formatDuration(totalMinutes)}
          </>
        )}
      </div>
      {step === 'confirm' ? (
        <Button type="button" className="h-12 min-w-36" disabled={busy} onClick={submit}>
          <Check size={18} />
          {busy ? 'Reservando…' : 'Reservar cita'}
        </Button>
      ) : (
        <Button
          type="button"
          className="h-12 min-w-32"
          disabled={!canContinue}
          onClick={() => go(steps[index + 1])}
        >
          Siguiente
        </Button>
      )}
    </div>
  );

  return (
    <Sheet
      title="Nueva cita"
      onClose={onClose}
      footer={footer}
      tall
      description={
        <ol className="mt-2 flex gap-1" aria-label="Pasos">
          {steps.map((item, position) => (
            <li key={item} className="flex-1">
              <button
                type="button"
                disabled={position > index}
                onClick={() => go(item)}
                aria-current={item === step ? 'step' : undefined}
                className="w-full text-left"
              >
                <span
                  className={cn(
                    'block h-1.5 rounded-full',
                    position <= index ? 'bg-primary' : 'bg-border',
                  )}
                />
                <span
                  className={cn(
                    'mt-1 hidden text-[11px] sm:block',
                    item === step ? 'font-semibold text-foreground' : '',
                  )}
                >
                  {STEP_LABEL[item]}
                </span>
              </button>
            </li>
          ))}
        </ol>
      }
    >
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {step === 'client' && (
        <ClientStep
          client={client}
          onChange={(value) => {
            setClient(value);
            if (value) go('services');
          }}
          canCreate={can('clients.create')}
        />
      )}

      {step === 'services' && (
        <ServicesStep
          services={bookable}
          selected={serviceIds}
          onToggle={(id) => {
            setSlot(null);
            setServiceIds((current) =>
              current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
            );
          }}
        />
      )}

      {step === 'stylist' && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">¿Con quién?</h3>
          <StylistOption
            selected={stylistId === null}
            onClick={() => {
              setStylistId(null);
              setSlot(null);
              go('time');
            }}
            icon={<Users size={18} />}
            title="Cualquiera disponible"
            subtitle="Te enseño las horas de todo el equipo"
          />
          {capable.map((member) => (
            <StylistOption
              key={member.stylistId}
              selected={stylistId === member.stylistId}
              onClick={() => {
                setStylistId(member.stylistId);
                setSlot(null);
                go('time');
              }}
              icon={<span className="size-4 rounded-full" style={{ background: member.color }} />}
              title={member.name}
            />
          ))}
          {team.filter((member) => member.isBookable).length > capable.length && (
            <p className="pt-1 text-xs text-muted-foreground">
              No aparecen quienes no hacen alguno de los servicios elegidos.
            </p>
          )}
        </div>
      )}

      {step === 'time' && (
        <SlotPicker
          serviceIds={serviceIds}
          stylistId={stylistId}
          day={day}
          onDayChange={setDay}
          value={slot}
          onChange={setSlot}
          stylistNames={names}
          preferredStartsAt={initial?.startsAt}
        />
      )}

      {step === 'confirm' && client && slot && (
        <div className="space-y-4">
          <dl className="divide-y rounded-2xl border">
            <Summary label="Clienta" value={client.fullName} hint={client.phone ?? undefined} />
            <Summary
              label="Cuándo"
              value={`${dayLabel(new Date(slot.startsAt))}`}
              hint={`${time(slot.startsAt)} – ${time(slot.endsAt)}`}
            />
            <Summary
              label="Con"
              value={names.get(slot.stylistId)?.name ?? 'Profesional'}
              dot={names.get(slot.stylistId)?.color}
            />
            <Summary
              label="Servicios"
              value={chosen.map((service) => service.name).join(', ')}
              hint={`${money(totalPrice)} · ${formatDuration(totalMinutes)}`}
            />
          </dl>
          {client.allergies && (
            <p className="rounded-xl bg-warning/15 p-3 text-sm text-warning">
              <strong>Alergias:</strong> {client.allergies}
            </p>
          )}
          <fieldset>
            <legend className="text-sm font-semibold">¿Cómo la pidió?</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {SOURCES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={source === item.value}
                  onClick={() => setSource(item.value)}
                  className={cn(
                    'min-h-10 rounded-full border px-4 text-sm',
                    source === item.value
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-card',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-semibold">
            Nota para el equipo{' '}
            <span className="font-normal text-muted-foreground">(opcional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="Ej.: trae foto del color que quiere"
              className="mt-1.5 w-full rounded-xl border bg-background p-3 text-sm"
            />
          </label>
        </div>
      )}
    </Sheet>
  );
}

function ClientStep({
  client,
  onChange,
  canCreate,
}: {
  client: PosClient | null;
  onChange: (client: PosClient | null) => void;
  canCreate: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const response = await sessionFetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: String(data.get('firstName') ?? '').trim(),
        lastName: String(data.get('lastName') ?? '').trim(),
        phone: String(data.get('phone') ?? '').trim() || null,
      }),
    });
    setBusy(false);
    if (!response.ok) return setError(await problem(response, 'No pudimos guardar la clienta.'));
    const created = ((await response.json()) as { data: PosClient }).data;
    setCreating(false);
    onChange(created);
  }

  const field = 'mt-1.5 h-12 w-full rounded-xl border bg-background px-3 text-base';

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">¿Para quién es la cita?</h3>
      {!creating && (
        <ClientCombobox
          value={client}
          onChange={onChange}
          placeholder="Buscar por nombre o teléfono"
          label="Clienta de la cita"
        />
      )}
      {canCreate && !creating && !client && (
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full"
          onClick={() => setCreating(true)}
        >
          <UserPlus size={18} />
          Clienta nueva
        </Button>
      )}
      {creating && (
        <form onSubmit={create} className="space-y-3 rounded-2xl border p-4">
          <p className="text-sm font-semibold">Clienta nueva</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              Nombre
              <input
                name="firstName"
                required
                maxLength={100}
                autoComplete="off"
                className={field}
              />
            </label>
            <label className="block text-sm">
              Apellido
              <input
                name="lastName"
                required
                maxLength={100}
                autoComplete="off"
                className={field}
              />
            </label>
          </div>
          <label className="block text-sm">
            Teléfono (para el recordatorio por WhatsApp)
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              required
              maxLength={20}
              placeholder="5555 1234"
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Volver
            </Button>
            <Button disabled={busy}>{busy ? 'Guardando…' : 'Guardar y seguir'}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ServicesStep({
  services,
  selected,
  onToggle,
}: {
  services: Service[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const categories = useQuery({
    queryKey: ['booking-categories'],
    queryFn: async () => {
      const response = await sessionFetch(
        '/api/agenda?resource=categories&kind=SERVICE&isActive=true&limit=100',
      );
      if (!response.ok) return [];
      return ((await response.json()) as { data: { id: string; name: string }[] }).data;
    },
  });
  // Solo las categorías que de verdad tienen servicios para reservar.
  const used = (categories.data ?? []).filter((category) =>
    services.some((service) => service.categoryId === category.id),
  );
  const term = fold(search.trim());
  // Al buscar se busca en todo el menú: la categoría elegida no esconde resultados.
  const visible = services.filter(
    (service) =>
      (!term || fold(service.name).includes(term)) &&
      (term || !categoryId || service.categoryId === categoryId),
  );
  const picked = selected
    .map((id) => services.find((service) => service.id === id))
    .filter((service): service is Service => Boolean(service));

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">¿Qué se va a hacer?</h3>
      <label className="relative block">
        <span className="sr-only">Buscar servicio</span>
        <Search size={16} className="absolute top-3.5 left-3 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar servicio…"
          className="h-11 w-full rounded-xl border bg-background pr-3 pl-9 text-sm"
        />
      </label>
      {used.length > 1 && !term && (
        <div
          className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1"
          role="group"
          aria-label="Categorías"
        >
          {[{ id: null, name: 'Todos' }, ...used].map((category) => (
            <button
              key={category.id ?? 'todos'}
              type="button"
              aria-pressed={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
              className={cn(
                'min-h-9 shrink-0 rounded-full border px-4 text-sm',
                categoryId === category.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card',
              )}
            >
              {category.name}
            </button>
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Servicios elegidos">
          {picked.map((service) => (
            <button
              key={service.id}
              type="button"
              onClick={() => onToggle(service.id)}
              aria-label={`Quitar ${service.name}`}
              className="flex min-h-9 items-center gap-1 rounded-full bg-secondary px-3 text-xs font-semibold text-secondary-foreground"
            >
              {service.name}
              <X size={14} />
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {visible.map((service) => {
          const on = selected.includes(service.id);
          return (
            <button
              key={service.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(service.id)}
              className={cn(
                'flex min-h-16 items-center gap-3 rounded-2xl border p-3 text-left',
                on ? 'border-primary bg-primary/5 ring-2 ring-primary' : 'bg-card hover:bg-muted',
              )}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border',
                  on && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {on && <Check size={14} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{service.name}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock size={12} />
                  {formatDuration(service.blockedMinutes)} · {money(service.priceWithTax)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {visible.length === 0 && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          <Sparkles size={14} className="mr-1 inline" />
          Ningún servicio coincide.
        </p>
      )}
    </div>
  );
}

function StylistOption({
  selected,
  onClick,
  icon,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-14 w-full items-center gap-3 rounded-2xl border p-3 text-left',
        selected ? 'border-primary ring-2 ring-primary' : 'bg-card hover:bg-muted',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {subtitle && <span className="block text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </button>
  );
}

function Summary({
  label,
  value,
  hint,
  dot,
}: {
  label: string;
  value: string;
  hint?: string;
  dot?: string;
}) {
  return (
    <div className="flex gap-3 p-3">
      <dt className="w-24 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-medium first-letter:uppercase">
          {dot && <span className="size-3 rounded-full" style={{ background: dot }} />}
          {value}
        </span>
        {hint && <span className="block text-sm text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}
