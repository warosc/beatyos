'use client';
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type FormEvent,
  type RefObject,
} from 'react';
import { Plus, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { sessionFetch } from '@/lib/session-fetch';
import { commissionOf, IVA_RATE, splitPriceWithTax } from '@/lib/tax';
import { useDialog } from '@/lib/use-dialog';
import { money } from '@/lib/utils';

/** Servicio del catálogo tal como lo devuelve la API, con lo que hace falta para editarlo. */
export type CatalogService = {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  /** Lo que paga la clienta: es el precio que la dueña reconoce como suyo. */
  priceWithTax: string;
  taxRate: number;
  commissionRate: number | null;
};

type Message = { kind: 'success' | 'error'; text: string };
type Draft = { name: string; price: string; duration: string; cleanup: string; commission: string };

const EMPTY: Draft = { name: '', price: '', duration: '', cleanup: '', commission: '' };
const cents = (value: string) => Math.round(Number(value) * 100);
const quetzales = (amount: number) => money(amount / 100);

async function problem(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { detail?: string; message?: string };
  return body.detail ?? body.message ?? fallback;
}

/**
 * Lo que la dueña escribe y lo que el sistema deduce de ello.
 *
 * Ella piensa en lo que cobra con IVA; la API guarda el precio sin IVA. El reparto usa el
 * impuesto del propio servicio, que no tiene por qué ser el actual si se creó hace tiempo.
 */
function useServiceDraft(initial: Draft, taxRate: number) {
  const [draft, setDraft] = useState(initial);
  const typed = draft.price === '' ? 0 : cents(draft.price);
  return {
    draft,
    setDraft,
    field: (key: keyof Draft) => ({
      value: draft[key],
      onChange: (e: ChangeEvent<HTMLInputElement>) =>
        setDraft((current) => ({ ...current, [key]: e.target.value })),
    }),
    typed,
    taxRate,
    split: typed > 0 ? splitPriceWithTax(typed, taxRate) : null,
    minutes: Number(draft.duration) || 0,
    cleanupMinutes: Number(draft.cleanup) || 0,
    commissionRate: draft.commission === '' ? null : Number(draft.commission),
  };
}
type ServiceDraft = ReturnType<typeof useServiceDraft>;

/**
 * Alta de servicios pensada para la dueña, que da de alta todo su menú de una sentada.
 *
 * Pide lo que ella sabe —cuánto cobra y cuánto tarda— y el resto lo hace el sistema: el
 * precio sin IVA que guarda la API, el código del servicio (lo genera la API a partir del
 * nombre) y el resumen de cómo queda en caja y en la agenda antes de guardar.
 */
export function ServiceCreator({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const form = useServiceDraft(EMPTY, IVA_RATE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.split) return;
    setBusy(true);
    setMessage(null);
    const name = form.draft.name.trim();
    const response = await sessionFetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        durationMinutes: form.minutes,
        price: (form.split.base / 100).toFixed(2),
        taxRate: IVA_RATE,
        bufferMinutes: form.cleanupMinutes,
        commissionRate: form.commissionRate,
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage({ kind: 'error', text: await problem(response, 'No pudimos crear el servicio.') });
      return;
    }
    setMessage({
      kind: 'success',
      text: `«${name}» quedó creado: la clienta paga ${quetzales(form.split.total)}. Ya puedes agregar el siguiente.`,
    });
    // La limpieza suele ser la misma para todo el menú: se conserva para el siguiente.
    form.setDraft((current) => ({ ...EMPTY, cleanup: current.cleanup }));
    nameRef.current?.focus();
    await onCreated();
  }

  return (
    <Card className="p-6">
      <h2 className="font-display text-xl font-semibold">Agregar servicio</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Escribe lo que cobras y lo que tarda. El sistema calcula el IVA y deja lista la agenda.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-4 md:grid-cols-2">
        <ServiceFields form={form} nameRef={nameRef} />
        {message && <Notice message={message} />}
        <Button className="md:col-span-2" disabled={busy}>
          <Plus size={17} />
          {busy ? 'Guardando…' : 'Crear servicio'}
        </Button>
      </form>
    </Card>
  );
}

/** Edición de un servicio existente, con los mismos campos y el mismo resumen que el alta. */
export function ServiceEditor({
  service,
  close,
  saved,
}: {
  service: CatalogService;
  close: () => void;
  saved: (name: string) => Promise<unknown>;
}) {
  const dialogRef = useDialog(close);
  const form = useServiceDraft(
    {
      name: service.name,
      price: String(Number(service.priceWithTax)),
      duration: String(service.durationMinutes),
      cleanup: service.bufferMinutes ? String(service.bufferMinutes) : '',
      commission: service.commissionRate === null ? '' : String(service.commissionRate),
    },
    service.taxRate,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.split) return;
    setBusy(true);
    setMessage(null);
    const name = form.draft.name.trim();
    const priceChanged = form.split.total !== cents(service.priceWithTax);
    const response = await sessionFetch(`/api/services/${encodeURIComponent(service.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        durationMinutes: form.minutes,
        bufferMinutes: form.cleanupMinutes,
        commissionRate: form.commissionRate,
        // Solo si cambia: un cambio de precio queda registrado aparte en la auditoría.
        ...(priceChanged ? { price: (form.split.base / 100).toFixed(2) } : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage({
        kind: 'error',
        text: await problem(response, 'No pudimos guardar los cambios.'),
      });
      return;
    }
    await saved(name);
    close();
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Editar ${service.name}`}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-semibold">Editar servicio</h2>
          <button className="grid size-11 place-items-center" aria-label="Cerrar" onClick={close}>
            <X />
          </button>
        </div>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <ServiceFields form={form} />
          <p className="text-xs text-muted-foreground md:col-span-2">
            Las ventas ya cobradas conservan el precio de entonces; el nuevo vale desde ahora.
          </p>
          {message && <Notice message={message} />}
          <Button type="button" variant="outline" onClick={close}>
            Cancelar
          </Button>
          <Button disabled={busy}>
            <Save size={17} />
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </Button>
        </form>
      </div>
    </div>
  );
}

function ServiceFields({
  form,
  nameRef,
}: {
  form: ServiceDraft;
  nameRef?: RefObject<HTMLInputElement | null>;
}) {
  const { split, typed, minutes, cleanupMinutes, commissionRate, taxRate } = form;
  return (
    <>
      <Field
        wide
        ref={nameRef}
        label="Nombre del servicio"
        {...form.field('name')}
        required
        maxLength={120}
        placeholder="Corte de señora"
      />
      <Field
        label="Precio que paga la clienta (Q)"
        hint="Con IVA incluido, tal como lo dices en el salón."
        {...form.field('price')}
        required
        type="number"
        min="0.01"
        step="0.01"
        inputMode="decimal"
        placeholder="100"
      />
      <Field
        label="Duración (minutos)"
        hint="Tiempo que pasas atendiendo a la clienta."
        {...form.field('duration')}
        required
        type="number"
        min="1"
        max="480"
        step="1"
        inputMode="numeric"
        placeholder="45"
      />
      <Field
        label="Limpieza después (minutos, opcional)"
        hint="No se cobra. Deja ese tiempo libre en la agenda antes de la siguiente cita."
        {...form.field('cleanup')}
        type="number"
        min="0"
        max="120"
        step="1"
        inputMode="numeric"
        placeholder="0"
      />
      <Field
        label="Comisión especial (%, opcional)"
        hint="Déjalo vacío para que cada estilista gane su porcentaje de siempre."
        {...form.field('commission')}
        type="number"
        min="0"
        max="100"
        step="0.01"
        inputMode="decimal"
        placeholder="La de cada estilista"
      />

      {split && (
        <div
          role="status"
          aria-label="Resumen del servicio"
          className="space-y-1 rounded-xl bg-secondary p-4 text-sm md:col-span-2"
        >
          <p>
            La clienta paga <strong>{quetzales(split.total)}</strong>: {quetzales(split.base)} para
            el salón + {quetzales(split.tax)} de IVA.
          </p>
          {split.total !== typed && (
            <p className="font-medium">
              Con el IVA del {taxRate} % no se puede cobrar exactamente {quetzales(typed)}; se
              ajustó a {quetzales(split.total)}.
            </p>
          )}
          {minutes > 0 && (
            <p>
              En la agenda ocupa <strong>{minutes + cleanupMinutes} min</strong>
              {cleanupMinutes > 0 && ` (${minutes} de servicio + ${cleanupMinutes} de limpieza)`}.
            </p>
          )}
          <p>
            Comisión:{' '}
            {commissionRate === null
              ? 'la de cada estilista.'
              : `${commissionRate} % = ${quetzales(commissionOf(split.base, commissionRate))} por servicio (sobre el precio sin IVA).`}
          </p>
        </div>
      )}
    </>
  );
}

function Notice({ message }: { message: Message }) {
  return (
    <p
      role={message.kind === 'error' ? 'alert' : 'status'}
      className={`rounded-xl p-3 text-sm md:col-span-2 ${message.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10'}`}
    >
      {message.text}
    </p>
  );
}

function Field({
  label,
  hint,
  wide = false,
  ...props
}: { label: string; hint?: string; wide?: boolean } & ComponentProps<'input'>) {
  const id = useId();
  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 h-11 w-full rounded-xl border bg-background px-3"
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
