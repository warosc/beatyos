'use client';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, Search, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog-close';
import { ClientCombobox, type PosClient } from '@/features/sales/client-combobox';
import { canPerform } from '@/features/sales/stylist-select';
import { localDay } from '@/lib/dates';
import { sessionFetch } from '@/lib/session-fetch';
import { useDialog } from '@/lib/use-dialog';
import { cn, money } from '@/lib/utils';
import type { Service, Stylist } from './types';

type Slot = { startsAt: string; endsAt: string; durationMinutes: number };
type Category = { id: string; name: string };

const STEPS = ['Clienta', 'Servicios', 'Profesional y hora', 'Confirmar'] as const;

const duration = (minutes: number) =>
  minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
const hourOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
/** Sin tildes ni mayúsculas: «depilacion» encuentra «Depilación». */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * Reservar una cita en cuatro pasos: clienta, servicios, profesional y hora, confirmar.
 *
 * Un solo formulario largo no cabía en pantalla con un menú de veinte servicios: el botón
 * de reservar quedaba fuera de la vista, y en el teléfono era peor. Cada paso pide una
 * cosa, los botones y el resumen —servicios, tiempo y total— quedan siempre fijos abajo, y
 * la hora se elige entre los huecos libres que calcula la API en lugar de a prueba y error.
 */
export function BookingWizard({
  initialClientId,
  stylists,
  services,
  ownStylist,
  onClose,
  onSaved,
}: {
  initialClientId?: string;
  stylists: Stylist[];
  services: Service[];
  /** Con ámbito propio: la ficha a bloquear, `null` si no tiene una vinculada, `undefined` si no aplica. */
  ownStylist?: Stylist | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useDialog(onClose);
  // Desde la ficha de una clienta, el primer paso ya está hecho.
  const [step, setStep] = useState(initialClientId ? 1 : 0);
  const [picked, setPicked] = useState<PosClient | null | undefined>(undefined);
  const initialClient = useQuery({
    queryKey: ['booking-client', initialClientId],
    enabled: Boolean(initialClientId),
    queryFn: async () => {
      const response = await sessionFetch(`/api/clients/${encodeURIComponent(initialClientId!)}`);
      if (!response.ok) return null;
      return ((await response.json()) as { data: PosClient }).data;
    },
  });
  const client = picked === undefined ? (initialClient.data ?? null) : picked;
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [chosenStylist, setChosenStylist] = useState<string | null>(null);
  const stylistId = ownStylist !== undefined ? (ownStylist?.id ?? null) : chosenStylist;
  const [day, setDay] = useState(() => localDay());
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const bookable = services.filter((service) => service.isBookable);
  const chosen = serviceIds
    .map((id) => bookable.find((service) => service.id === id))
    .filter((service): service is Service => Boolean(service));
  const total = chosen.reduce((sum, service) => sum + Number(service.priceWithTax), 0);
  const slots = useQuery({
    queryKey: ['availability', stylistId, day, serviceIds.join(',')],
    enabled: step >= 2 && Boolean(stylistId && day && serviceIds.length),
    queryFn: async () => {
      const params = new URLSearchParams({
        resource: 'availability',
        stylistId: stylistId!,
        date: day,
        serviceIds: serviceIds.join(','),
      });
      const response = await sessionFetch(`/api/agenda?${params}`);
      if (!response.ok) throw new Error('No pudimos consultar las horas libres.');
      return ((await response.json()) as { data: Slot[] }).data;
    },
  });
  const slot = slots.data?.find((item) => item.startsAt === startsAt);
  // La duración exacta la da el hueco (cada profesional tiene sus tiempos); antes de
  // elegirlo, la del catálogo con su limpieza.
  const minutes =
    slot?.durationMinutes ?? chosen.reduce((sum, service) => sum + service.blockedMinutes, 0);
  const stylist =
    ownStylist ?? stylists.find((candidate) => candidate.id === stylistId) ?? undefined;

  const canAdvance = [Boolean(client), chosen.length > 0, Boolean(stylistId && startsAt), true][
    step
  ];

  function toggleService(id: string) {
    setServiceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    // Otro conjunto de servicios dura otra cosa: la hora elegida puede dejar de caber.
    setStartsAt(null);
  }

  async function book() {
    if (!client || !stylistId || !startsAt || !chosen.length) return;
    setBusy(true);
    setError('');
    const response = await sessionFetch('/api/agenda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        stylistId,
        startsAt,
        serviceIds,
        source: 'STAFF',
        ...(note.trim() ? { internalNotes: note.trim() } : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        message?: string;
        errors?: { message: string }[];
      };
      setError(
        body.errors?.map((item) => item.message).join('. ') ??
          body.detail ??
          body.message ??
          'No pudimos reservar la cita.',
      );
      return;
    }
    onSaved();
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Nueva cita"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
    >
      {/* En el teléfono ocupa la pantalla entera; en pantallas grandes, una ventana. El
          cuerpo se desplaza y la cabecera y el pie con los botones quedan siempre a la vista. */}
      <div className="flex h-[100dvh] w-full flex-col bg-card sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-2xl">
        <header className="border-b p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-2xl font-semibold">Nueva cita</h2>
            <DialogClose onClose={onClose} />
          </div>
          <ol className="mt-3 grid grid-cols-4 gap-2" aria-label="Pasos">
            {STEPS.map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  // Se vuelve a cualquier paso ya hecho; los siguientes, con «Siguiente».
                  disabled={index > step}
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => setStep(index)}
                  className="w-full text-left disabled:cursor-default"
                >
                  <span
                    className={cn(
                      'block h-1.5 rounded-full',
                      index <= step ? 'bg-primary' : 'bg-muted',
                    )}
                  />
                  <span
                    className={cn(
                      'mt-1.5 hidden text-xs sm:block',
                      index === step ? 'font-semibold' : 'text-muted-foreground',
                    )}
                  >
                    {index + 1}. {label}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 text-xs font-semibold sm:hidden">
            Paso {step + 1} de {STEPS.length}: {STEPS[step]}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {step === 0 && (
            <section className="space-y-3">
              <h3 className="text-lg font-semibold">¿Para quién es la cita?</h3>
              <ClientCombobox
                value={client}
                onChange={setPicked}
                label="Clienta"
                placeholder="Buscar por nombre o teléfono"
              />
            </section>
          )}
          {step === 1 && (
            <ServicePicker services={bookable} selected={serviceIds} onToggle={toggleService} />
          )}
          {step === 2 && (
            <section className="space-y-5">
              {ownStylist === null ? (
                <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
                  Tu cuenta no tiene una ficha de profesional vinculada. Pide a la propietaria que
                  la enlace antes de agendar.
                </p>
              ) : ownStylist ? (
                <p className="text-sm">
                  Con <strong>{ownStylist.displayName}</strong> (tú)
                </p>
              ) : (
                <StylistPicker
                  stylists={stylists}
                  serviceIds={serviceIds}
                  value={chosenStylist}
                  onChange={(id) => {
                    setChosenStylist(id);
                    setStartsAt(null);
                  }}
                />
              )}
              {stylistId && (
                <div className="space-y-3">
                  <label className="block text-sm font-semibold">
                    Día
                    <input
                      type="date"
                      value={day}
                      min={localDay()}
                      onChange={(event) => {
                        setDay(event.target.value);
                        setStartsAt(null);
                      }}
                      className="mt-1.5 block h-11 w-full rounded-xl border bg-background px-3 sm:w-60"
                    />
                  </label>
                  <TimePicker
                    // Otro día u otra profesional empiezan de cero, también la hora escrita.
                    key={`${stylistId}-${day}`}
                    day={day}
                    slots={slots.data}
                    pending={slots.isPending}
                    failed={slots.error?.message}
                    value={startsAt}
                    onChange={setStartsAt}
                  />
                </div>
              )}
            </section>
          )}
          {step === 3 && client && stylist && startsAt && (
            <section className="space-y-4">
              <h3 className="text-lg font-semibold">Revisa la cita</h3>
              <dl className="divide-y rounded-xl border">
                <Row label="Clienta">
                  {client.fullName}
                  {client.allergies && (
                    <span className="mt-1 flex items-start gap-1 text-xs font-medium text-danger">
                      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                      Alergias: {client.allergies}
                    </span>
                  )}
                </Row>
                <Row label="Servicios">
                  <ul className="space-y-1">
                    {chosen.map((service) => (
                      <li key={service.id} className="flex justify-between gap-3">
                        <span>{service.name}</span>
                        <span className="tabular-nums">{money(service.priceWithTax)}</span>
                      </li>
                    ))}
                  </ul>
                </Row>
                <Row label="Profesional">{stylist.displayName}</Row>
                <Row label="Cuándo">
                  {new Date(startsAt).toLocaleDateString('es-GT', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                  , {hourOf(startsAt)}
                  {slot && ` a ${hourOf(slot.endsAt)}`} · {duration(minutes)}
                </Row>
                <Row label="Total">
                  <strong className="tabular-nums">{money(total)}</strong>
                </Row>
              </dl>
              <label className="block text-sm font-semibold">
                Nota interna (opcional)
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={1000}
                  placeholder="Ej. trae su propio tinte, prefiere sin secador…"
                  className="mt-1.5 min-h-20 w-full rounded-xl border bg-background p-3 text-sm font-normal"
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  Solo la ve el equipo.
                </span>
              </label>
            </section>
          )}
        </div>

        <footer className="space-y-3 border-t p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5">
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-sm" aria-live="polite">
              {chosen.length ? (
                <>
                  <strong>
                    {chosen.length} {chosen.length === 1 ? 'servicio' : 'servicios'}
                  </strong>
                  <span className="block text-xs text-muted-foreground">
                    {slot ? '' : '≈ '}
                    {duration(minutes)} · {money(total)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {client ? client.fullName : 'Elige a la clienta'}
                </span>
              )}
            </p>
            {step > 0 && (
              <Button
                type="button"
                variant="outline"
                aria-label="Atrás"
                onClick={() => setStep(step - 1)}
              >
                <ChevronLeft size={17} />
                <span className="hidden sm:inline">Atrás</span>
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button type="button" disabled={!canAdvance} onClick={() => setStep(step + 1)}>
                Siguiente
              </Button>
            ) : (
              <Button type="button" disabled={busy} onClick={book}>
                {busy ? 'Reservando…' : 'Reservar cita'}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 p-3 text-sm sm:grid-cols-[120px_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Los servicios, con buscador y categorías: un menú de veinte no se recorre a ojo. */
function ServicePicker({
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
      return ((await response.json()) as { data: Category[] }).data;
    },
  });
  // Solo las categorías que de verdad tienen servicios para reservar.
  const used = (categories.data ?? []).filter((category) =>
    services.some((service) => service.categoryId === category.id),
  );
  const term = fold(search.trim());
  const visible = services.filter(
    (service) =>
      (!term || fold(service.name).includes(term)) &&
      (term || !categoryId || service.categoryId === categoryId),
  );
  const picked = selected
    .map((id) => services.find((service) => service.id === id))
    .filter((service): service is Service => Boolean(service));

  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold">¿Qué se va a hacer?</h3>
      <label className="flex h-11 items-center gap-2 rounded-xl border bg-background px-3">
        <Search size={17} className="text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Buscar servicio"
          placeholder="Buscar servicio…"
          className="w-full bg-transparent text-sm outline-none"
        />
      </label>
      {used.length > 1 && !term && (
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Categorías">
          <Chip selected={!categoryId} onClick={() => setCategoryId(null)}>
            Todos
          </Chip>
          {used.map((category) => (
            <Chip
              key={category.id}
              selected={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name}
            </Chip>
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
              className="flex min-h-9 items-center gap-1 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground"
            >
              {service.name}
              <X size={14} />
            </button>
          ))}
        </div>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {visible.map((service) => {
          const on = selected.includes(service.id);
          return (
            <li key={service.id}>
              <label
                className={cn(
                  'flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm',
                  on ? 'border-primary bg-secondary' : 'hover:bg-muted',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(service.id)}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{service.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {duration(service.blockedMinutes)}
                  </span>
                </span>
                <span className="font-semibold tabular-nums">{money(service.priceWithTax)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!visible.length && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {term ? `Ningún servicio coincide con «${search}».` : 'No hay servicios para reservar.'}
        </p>
      )}
    </section>
  );
}

/** Solo las profesionales que hacen todos los servicios elegidos: la API rechazaría a las demás. */
function StylistPicker({
  stylists,
  serviceIds,
  value,
  onChange,
}: {
  stylists: Stylist[];
  serviceIds: string[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const able = stylists.filter(
    (stylist) => stylist.isBookable && serviceIds.every((id) => canPerform(stylist, id)),
  );
  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">¿Con quién?</h3>
      {able.length ? (
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Profesional">
          {able.map((stylist) => (
            <button
              key={stylist.id}
              type="button"
              aria-pressed={value === stylist.id}
              onClick={() => onChange(stylist.id)}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-xl border px-3 text-left text-sm font-medium',
                value === stylist.id ? 'border-primary bg-secondary' : 'hover:bg-muted',
              )}
            >
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full"
                style={{ background: stylist.color }}
              />
              <span className="flex-1">{stylist.displayName}</span>
              {value === stylist.id && <Check size={16} className="text-primary" />}
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-xl bg-warning/15 p-3 text-sm text-warning">
          Ninguna profesional hace todos estos servicios. Quita alguno o agéndalos en citas
          separadas.
        </p>
      )}
    </div>
  );
}

/**
 * La hora, entre los huecos libres de ese día. Si hace falta una que no aparece —la
 * clienta llega antes, un hueco entre dos citas—, se puede escribir a mano y la API
 * comprueba que quepa.
 */
function TimePicker({
  day,
  slots,
  pending,
  failed,
  value,
  onChange,
}: {
  day: string;
  slots: Slot[] | undefined;
  pending: boolean;
  failed?: string;
  value: string | null;
  onChange: (startsAt: string | null) => void;
}) {
  const [manual, setManual] = useState('');
  const fromList = slots?.some((slot) => slot.startsAt === value);
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Hora</p>
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Buscando horas libres…
        </p>
      ) : failed ? (
        <p role="alert" className="text-sm text-danger">
          {failed}
        </p>
      ) : slots?.length ? (
        <div role="group" aria-label="Horas libres" className="flex flex-wrap gap-2">
          {slots.map((slot) => (
            <button
              key={slot.startsAt}
              type="button"
              aria-pressed={value === slot.startsAt}
              onClick={() => {
                setManual('');
                onChange(slot.startsAt);
              }}
              className={cn(
                'h-11 min-w-20 rounded-lg border px-3 text-sm font-semibold tabular-nums',
                value === slot.startsAt
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {hourOf(slot.startsAt)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Ese día no hay huecos libres con esta profesional. Prueba otro día o escribe la hora.
        </p>
      )}
      <label className="block text-sm font-semibold">
        Otra hora
        <input
          type="time"
          value={manual}
          onChange={(event) => {
            setManual(event.target.value);
            onChange(
              event.target.value ? new Date(`${day}T${event.target.value}`).toISOString() : null,
            );
          }}
          className={cn(
            'mt-1.5 block h-11 w-full rounded-xl border bg-background px-3 sm:w-40',
            manual && !fromList && 'border-primary',
          )}
        />
      </label>
    </div>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'h-9 shrink-0 rounded-full border px-3 text-xs font-semibold',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}
