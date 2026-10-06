'use client';
import { FormEvent, useId, useRef, useState, type ComponentProps } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { sessionFetch } from '@/lib/session-fetch';
import { commissionOf, IVA_RATE, splitPriceWithTax } from '@/lib/tax';
import { money } from '@/lib/utils';

type Message = { kind: 'success' | 'error'; text: string };

const cents = (value: string) => Math.round(Number(value) * 100);
const quetzales = (amount: number) => money(amount / 100);

/**
 * Alta de servicios pensada para la dueña, que da de alta todo su menú de una sentada.
 *
 * Pide lo que ella sabe —cuánto cobra y cuánto tarda— y el resto lo hace el sistema: el
 * precio sin IVA que guarda la API, el código del servicio (lo genera la API a partir del
 * nombre) y el resumen de cómo queda en caja y en la agenda antes de guardar.
 */
export function ServiceCreator({ onCreated }: { onCreated: () => Promise<void> }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('');
  const [cleanup, setCleanup] = useState('');
  const [commission, setCommission] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const typed = price === '' ? 0 : cents(price);
  const split = typed > 0 ? splitPriceWithTax(typed) : null;
  const minutes = Number(duration) || 0;
  const cleanupMinutes = Number(cleanup) || 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!split) return;
    setBusy(true);
    setMessage(null);
    const response = await sessionFetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        durationMinutes: minutes,
        price: (split.base / 100).toFixed(2),
        taxRate: IVA_RATE,
        bufferMinutes: cleanupMinutes,
        commissionRate: commission === '' ? null : Number(commission),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        message?: string;
      };
      setMessage({
        kind: 'error',
        text: body.detail ?? body.message ?? 'No pudimos crear el servicio.',
      });
      return;
    }
    setMessage({
      kind: 'success',
      text: `«${name.trim()}» quedó creado: la clienta paga ${quetzales(split.total)}. Ya puedes agregar el siguiente.`,
    });
    // La limpieza suele ser la misma para todo el menú: se conserva para el siguiente.
    setName('');
    setPrice('');
    setDuration('');
    setCommission('');
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
        <Field
          wide
          ref={nameRef}
          label="Nombre del servicio"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Corte de señora"
        />
        <Field
          label="Precio que paga la clienta (Q)"
          hint="Con IVA incluido, tal como lo dices en el salón."
          value={price}
          onChange={(e) => setPrice(e.target.value)}
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
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
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
          value={cleanup}
          onChange={(e) => setCleanup(e.target.value)}
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
          value={commission}
          onChange={(e) => setCommission(e.target.value)}
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
              La clienta paga <strong>{quetzales(split.total)}</strong>: {quetzales(split.base)}{' '}
              para el salón + {quetzales(split.tax)} de IVA.
            </p>
            {split.total !== typed && (
              <p className="font-medium">
                Con el IVA del {IVA_RATE} % no se puede cobrar exactamente {quetzales(typed)}; se
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
              {commission === ''
                ? 'la de cada estilista.'
                : `${commission} % = ${quetzales(commissionOf(split.base, Number(commission)))} por servicio (sobre el precio sin IVA).`}
            </p>
          </div>
        )}

        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`rounded-xl p-3 text-sm md:col-span-2 ${message.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10'}`}
          >
            {message.text}
          </p>
        )}
        <Button className="md:col-span-2" disabled={busy}>
          <Plus size={17} />
          {busy ? 'Guardando…' : 'Crear servicio'}
        </Button>
      </form>
    </Card>
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
