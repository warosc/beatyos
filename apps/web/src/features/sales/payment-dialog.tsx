'use client';
import Link from 'next/link';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useDialog } from '@/lib/use-dialog';
import { cn, money } from '@/lib/utils';
import { toCents } from './cart';
import {
  MAX_PAYMENTS,
  METHOD_LABEL,
  METHODS,
  changeCents,
  paymentProblem,
  quickTenders,
  remainingCents,
  toPayments,
  totalChangeCents,
  type PaymentMethod,
  type PaymentRow,
} from './payment';

type Draft = {
  id: number;
  method: PaymentMethod;
  amountText: string;
  tenderedText: string;
  reference: string;
};

export type ConfirmPayments = (
  payments: ReturnType<typeof toPayments>,
  changeCents: number,
) => Promise<string | null>;

const REFERENCE_HINT: Partial<Record<PaymentMethod, string>> = {
  CARD: 'Autorización o últimos 4 dígitos (opcional)',
  TRANSFER: 'Número de transferencia (opcional)',
  OTHER: 'Detalle (opcional)',
};

const parseCents = (text: string) => (text.trim() === '' ? null : toCents(text.replace(',', '.')));

/**
 * Diálogo de cobro, compartido por el punto de venta y por Caja.
 *
 * Con varios pagos, el último absorbe lo que falta: la cajera escribe cuánto va con cada
 * método menos el último y la suma cuadra sola, que es lo que exige la API.
 */
export function PaymentDialog({
  title,
  subtitle,
  totalCents,
  summary,
  cashOpen,
  onClose,
  onConfirm,
}: {
  title: string;
  subtitle?: string;
  totalCents: number;
  summary?: ReactNode;
  /** `null` si quien cobra no puede consultar la caja: entonces decide el servidor. */
  cashOpen: boolean | null;
  onClose: () => void;
  onConfirm: ConfirmPayments;
}) {
  const dialogRef = useDialog(onClose);
  const firstInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(2);
  const [drafts, setDrafts] = useState<Draft[]>([
    {
      id: 1,
      method: cashOpen === false ? 'CARD' : 'CASH',
      amountText: '',
      tenderedText: '',
      reference: '',
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Después del foco que pone `useDialog` en el primer botón: lo útil es poder escribir
  // enseguida lo que entrega la clienta.
  useEffect(() => firstInput.current?.focus(), []);

  const rows: PaymentRow[] = drafts.map((draft, index) => {
    const last = index === drafts.length - 1;
    const others = drafts
      .slice(0, -1)
      .reduce((sum, other) => sum + (parseCents(other.amountText) ?? 0), 0);
    return {
      id: String(draft.id),
      method: draft.method,
      amountCents: last ? Math.max(0, totalCents - others) : (parseCents(draft.amountText) ?? 0),
      tenderedCents: draft.method === 'CASH' ? parseCents(draft.tenderedText) : null,
      reference: draft.reference,
    };
  });
  const problem = paymentProblem(totalCents, rows, cashOpen);
  const change = totalChangeCents(rows);
  const split = drafts.length > 1;

  const update = (id: number, patch: Partial<Draft>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );

  /**
   * Pasa a cobrar con un método más. El pago que absorbía el resto pasa a tener importe
   * propio: lo que entregó la clienta en efectivo si no alcanzaba —el caso típico: «le doy
   * 100 y el resto con tarjeta»— o vacío para escribirlo. El nuevo absorbe lo que falte.
   */
  function splitPayment(restMethod?: PaymentMethod) {
    setDrafts((current) => {
      const fixed = current.map((draft, index) => {
        if (index !== current.length - 1) return draft;
        const tendered = draft.method === 'CASH' ? parseCents(draft.tenderedText) : null;
        const partial =
          tendered != null && tendered > 0 && tendered < rows[index].amountCents ? tendered : null;
        return {
          ...draft,
          amountText: partial != null ? (partial / 100).toFixed(2) : '',
          tenderedText: '',
        };
      });
      const method: PaymentMethod =
        restMethod ?? (current.some((d) => d.method === 'CARD') ? 'TRANSFER' : 'CARD');
      return [
        ...fixed,
        { id: nextId.current++, method, amountText: '', tenderedText: '', reference: '' },
      ];
    });
  }

  // Efectivo que no alcanza, con un solo pago: se ofrece cobrar el resto con otro método.
  const shortfall =
    !split &&
    rows[0].method === 'CASH' &&
    rows[0].tenderedCents != null &&
    rows[0].tenderedCents > 0 &&
    rows[0].tenderedCents < rows[0].amountCents
      ? rows[0].amountCents - rows[0].tenderedCents
      : 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    const failure = await onConfirm(toPayments(rows), change);
    setBusy(false);
    if (failure) setError(failure);
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <form
        onSubmit={submit}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl bg-card p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-semibold">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Total</p>
            <p className="text-3xl font-bold tabular-nums">{money(totalCents / 100)}</p>
          </div>
        </div>

        {summary}

        {drafts.map((draft, index) => {
          const row = rows[index];
          const last = index === drafts.length - 1;
          return (
            <fieldset key={draft.id} className="space-y-3 rounded-xl border p-3">
              <legend className="sr-only">Pago {index + 1}</legend>
              <div className="flex items-center gap-2">
                <div
                  className="grid flex-1 grid-cols-4 gap-1.5"
                  role="group"
                  aria-label="Método de pago"
                >
                  {METHODS.map((method) => {
                    const blocked = method === 'CASH' && cashOpen === false;
                    return (
                      <button
                        key={method}
                        type="button"
                        aria-pressed={draft.method === method}
                        disabled={blocked}
                        title={blocked ? 'La caja está cerrada' : undefined}
                        onClick={() => update(draft.id, { method })}
                        className={cn(
                          'h-11 rounded-lg border text-sm font-semibold transition disabled:opacity-40',
                          draft.method === method
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'bg-background hover:border-primary',
                        )}
                      >
                        {METHOD_LABEL[method]}
                      </button>
                    );
                  })}
                </div>
                {split && (
                  <button
                    type="button"
                    aria-label={`Quitar pago ${index + 1}`}
                    onClick={() => setDrafts((current) => current.filter((d) => d.id !== draft.id))}
                    className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              {split && (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{last ? 'Resto' : 'Importe'}</span>
                  <input
                    inputMode="decimal"
                    // Al dividir, el cursor va a donde hay que escribir cuánto se paga así.
                    autoFocus={!last && draft.amountText === ''}
                    readOnly={last}
                    aria-label={`Importe del pago ${index + 1}`}
                    value={last ? (row.amountCents / 100).toFixed(2) : draft.amountText}
                    onChange={(event) => update(draft.id, { amountText: event.target.value })}
                    className={cn(
                      'h-10 w-36 rounded-lg border bg-background px-3 text-right tabular-nums',
                      last && 'bg-muted text-muted-foreground',
                    )}
                  />
                </label>
              )}

              {draft.method === 'CASH' ? (
                <div className="space-y-2">
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">Recibe</span>
                    <input
                      ref={index === 0 ? firstInput : undefined}
                      inputMode="decimal"
                      aria-label="Efectivo recibido"
                      placeholder={(row.amountCents / 100).toFixed(2)}
                      value={draft.tenderedText}
                      onChange={(event) => update(draft.id, { tenderedText: event.target.value })}
                      className="h-10 w-36 rounded-lg border bg-background px-3 text-right tabular-nums"
                    />
                  </label>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {quickTenders(row.amountCents).map((cents, i) => (
                      <button
                        key={cents}
                        type="button"
                        onClick={() => update(draft.id, { tenderedText: (cents / 100).toFixed(2) })}
                        className="h-8 rounded-full border px-3 text-xs font-semibold hover:border-primary"
                      >
                        {i === 0 ? 'Exacto' : money(cents / 100)}
                      </button>
                    ))}
                  </div>
                  {shortfall > 0 && (
                    <div className="rounded-lg bg-warning/10 p-3 text-sm">
                      <p>
                        Faltan <strong className="tabular-nums">{money(shortfall / 100)}</strong>.
                        Cobra el resto con:
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => splitPayment('CARD')}
                        >
                          Resto con tarjeta
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => splitPayment('TRANSFER')}
                        >
                          Resto con transferencia
                        </Button>
                      </div>
                    </div>
                  )}
                  {changeCents(row) > 0 && (
                    <p className="flex items-baseline justify-between rounded-lg bg-success/10 px-3 py-2 text-success">
                      <span className="text-sm font-semibold">Vuelto</span>
                      <span className="text-2xl font-bold tabular-nums">
                        {money(changeCents(row) / 100)}
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <input
                  ref={index === 0 ? firstInput : undefined}
                  aria-label={`Referencia del pago ${index + 1}`}
                  placeholder={REFERENCE_HINT[draft.method]}
                  maxLength={150}
                  value={draft.reference}
                  onChange={(event) => update(draft.id, { reference: event.target.value })}
                  className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
                />
              )}
            </fieldset>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          {drafts.length < MAX_PAYMENTS ? (
            <Button type="button" variant="ghost" onClick={() => splitPayment()}>
              <Plus size={16} />
              {split ? 'Agregar otro método' : 'Dividir pago'}
            </Button>
          ) : (
            <span />
          )}
          {split && (
            <span className="text-muted-foreground">
              Restante{' '}
              <strong className="tabular-nums text-foreground">
                {money(remainingCents(totalCents, rows) / 100)}
              </strong>
            </span>
          )}
        </div>

        {cashOpen === false && (
          <p className="rounded-xl bg-warning/10 p-3 text-sm text-warning">
            La caja está cerrada: solo se puede cobrar con tarjeta o transferencia.{' '}
            <Link href="/caja" className="font-semibold underline">
              Abrir caja
            </Link>
          </p>
        )}
        {error ? (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        ) : (
          problem &&
          cashOpen !== false &&
          !shortfall && (
            <p role="status" className="text-right text-sm text-muted-foreground">
              {problem}
            </p>
          )
        )}

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || !!problem}>
            {busy ? 'Cobrando…' : `Confirmar ${money(totalCents / 100)}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
