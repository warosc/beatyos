'use client';
import { AlertCircle, Minus, Percent, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, money } from '@/lib/utils';
import {
  cartTotals,
  discountFromPercent,
  lineAmounts,
  removeLine,
  setDiscount,
  setQuantity,
  setStylist,
  toCents,
  type CartLine,
} from './cart';
import { ClientCombobox, type PosClient } from './client-combobox';
import { StylistSelect, type PosStylist } from './stylist-select';

export type Notice = { kind: 'success' | 'error'; text: string };

/**
 * La cuenta que se está armando: quién es la clienta, quién hizo cada cosa y cuánto suma.
 *
 * La profesional de cada línea es la que cobra la comisión. «Atiende» solo decide la de
 * las líneas nuevas; cada línea se puede corregir después.
 */
export function CartPanel({
  lines,
  onLines,
  stylists,
  defaultStylistId,
  onDefaultStylist,
  client,
  onClient,
  canChooseClient,
  canDiscount,
  canCharge,
  cashOpen,
  notice,
  onNotice,
  onCharge,
  className,
}: {
  lines: CartLine[];
  onLines: (lines: CartLine[]) => void;
  /** `null` cuando quien cobra no puede elegir profesional: sus líneas son suyas. */
  stylists: PosStylist[] | null;
  defaultStylistId: string | null;
  onDefaultStylist: (id: string | null) => void;
  client: PosClient | null;
  onClient: (client: PosClient | null) => void;
  canChooseClient: boolean;
  canDiscount: boolean;
  canCharge: boolean;
  cashOpen: boolean | null;
  notice: Notice | null;
  onNotice: (notice: Notice | null) => void;
  onCharge: () => void;
  className?: string;
}) {
  const totals = cartTotals(lines);
  const listRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(lines.length);
  // Lo recién agregado va al final: se lleva a la vista para que la cajera vea que entró.
  useEffect(() => {
    if (lines.length > previousCount.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }
    previousCount.current = lines.length;
  }, [lines.length]);
  const unassigned = lines.some((line) => line.item.kind === 'SERVICE' && !line.stylistId);

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
            <ShoppingBag size={20} className="text-primary" />
            Cuenta
          </h2>
          {cashOpen != null && (
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                cashOpen ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning',
              )}
            >
              {cashOpen ? 'Caja abierta' : 'Caja cerrada'}
            </span>
          )}
        </div>
        {canChooseClient && <ClientCombobox value={client} onChange={onClient} />}
        {stylists && (
          <label className="flex items-center gap-3 text-sm">
            <span className="w-16 shrink-0 font-medium">Atiende</span>
            <StylistSelect
              stylists={stylists}
              value={defaultStylistId}
              onChange={onDefaultStylist}
              label="Estilista de las líneas nuevas"
              className="flex-1"
            />
          </label>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {lines.length ? (
          <ul className="space-y-2" aria-label="Líneas de la cuenta">
            {lines.map((line) => (
              <LineEditor
                key={line.key}
                line={line}
                lines={lines}
                onLines={onLines}
                onNotice={onNotice}
                stylists={stylists}
                canDiscount={canDiscount}
              />
            ))}
          </ul>
        ) : (
          <p className="px-6 py-16 text-center text-sm text-muted-foreground">
            Busca un servicio o producto y pulsa <kbd className="rounded border px-1">Enter</kbd>{' '}
            para agregarlo.
          </p>
        )}
      </div>

      <div className="space-y-3 border-t p-4">
        <dl className="space-y-1 text-sm">
          <Row label="Subtotal" cents={totals.subtotalCents} />
          {totals.discountCents > 0 && <Row label="Descuentos" cents={-totals.discountCents} />}
          <Row label="IVA" cents={totals.taxCents} />
          <div className="flex items-baseline justify-between pt-1 text-xl font-bold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(totals.totalCents / 100)}</dd>
          </div>
        </dl>
        {unassigned && stylists && (
          <p className="text-xs text-warning">
            Hay servicios sin estilista: no sumarán comisión a nadie.
          </p>
        )}
        {notice && (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'flex items-start gap-2 rounded-xl p-3 text-sm',
              notice.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success',
            )}
          >
            {notice.kind === 'error' && <AlertCircle className="mt-0.5 shrink-0" size={16} />}
            {notice.text}
          </p>
        )}
        {canCharge && (
          <Button className="h-14 w-full text-base" disabled={!lines.length} onClick={onCharge}>
            Cobrar {money(totals.totalCents / 100)}
            <kbd className="ml-1 rounded border border-primary-foreground/40 px-1.5 text-xs font-normal">
              F2
            </kbd>
          </Button>
        )}
      </div>
    </Card>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <dt>{label}</dt>
      <dd className="tabular-nums">{money(cents / 100)}</dd>
    </div>
  );
}

function LineEditor({
  line,
  lines,
  onLines,
  onNotice,
  stylists,
  canDiscount,
}: {
  line: CartLine;
  lines: CartLine[];
  onLines: (lines: CartLine[]) => void;
  onNotice: (notice: Notice | null) => void;
  stylists: PosStylist[] | null;
  canDiscount: boolean;
}) {
  const [editingDiscount, setEditingDiscount] = useState(false);
  const amounts = lineAmounts(line);

  function quantity(next: number) {
    const result = setQuantity(lines, line.key, next);
    onLines(result.lines);
    onNotice(result.error ? { kind: 'error', text: result.error } : null);
  }

  return (
    <li className="rounded-xl border bg-background p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ background: line.item.color ?? 'var(--color-border)' }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{line.item.name}</p>
          <p className="text-xs text-muted-foreground">
            {money(lineAmounts({ ...line, quantity: 1, discountCents: 0 }).totalCents / 100)} c/u
            {amounts.discountCents > 0 && (
              <span className="text-success"> · −{money(amounts.discountCents / 100)}</span>
            )}
          </p>
        </div>
        <strong className="tabular-nums">{money(amounts.totalCents / 100)}</strong>
        <button
          type="button"
          aria-label={`Quitar ${line.item.name}`}
          onClick={() => onLines(removeLine(lines, line.key))}
          className="-mr-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-danger"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {stylists && (
          <StylistSelect
            stylists={stylists}
            value={line.stylistId}
            onChange={(id) => onLines(setStylist(lines, line.key, id))}
            serviceId={line.item.kind === 'SERVICE' ? line.item.id : undefined}
            label={`Estilista de ${line.item.name}`}
            className="min-w-[8rem] flex-1"
          />
        )}
        <div className="flex items-center rounded-lg border">
          <button
            type="button"
            aria-label={`Una menos de ${line.item.name}`}
            disabled={line.quantity <= 1}
            onClick={() => quantity(line.quantity - 1)}
            className="grid size-10 place-items-center rounded-l-lg hover:bg-muted disabled:opacity-40"
          >
            <Minus size={14} />
          </button>
          <input
            type="number"
            min={line.item.kind === 'SERVICE' ? 1 : 0.001}
            step={line.item.kind === 'SERVICE' ? 1 : 'any'}
            aria-label={`Cantidad de ${line.item.name}`}
            value={line.quantity}
            onChange={(event) => {
              if (event.target.value !== '') quantity(Number(event.target.value));
            }}
            className="h-10 w-14 border-x bg-transparent text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label={`Una más de ${line.item.name}`}
            onClick={() => quantity(line.quantity + 1)}
            className="grid size-10 place-items-center rounded-r-lg hover:bg-muted"
          >
            <Plus size={14} />
          </button>
        </div>
        {canDiscount && (
          <Button
            type="button"
            variant="outline"
            aria-expanded={editingDiscount}
            onClick={() => setEditingDiscount((open) => !open)}
            className="min-h-10 px-3"
          >
            <Percent size={14} />
            Descuento
          </Button>
        )}
      </div>

      {canDiscount && editingDiscount && (
        <DiscountEditor
          grossCents={amounts.grossCents}
          currentCents={line.discountCents}
          onApply={(cents) => {
            onLines(setDiscount(lines, line.key, cents));
            setEditingDiscount(false);
          }}
        />
      )}
    </li>
  );
}

function DiscountEditor({
  grossCents,
  currentCents,
  onApply,
}: {
  grossCents: number;
  currentCents: number;
  onApply: (cents: number) => void;
}) {
  const [unit, setUnit] = useState<'Q' | '%'>('Q');
  const [text, setText] = useState(currentCents ? (currentCents / 100).toFixed(2) : '');

  function apply(event: FormEvent) {
    event.preventDefault();
    const value = Number(text.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return;
    onApply(unit === '%' ? discountFromPercent(grossCents, value) : toCents(value));
  }

  return (
    // Formulario propio para que Enter aplique el descuento sin salir del campo.
    <form onSubmit={apply} className="mt-2 flex items-center gap-2 rounded-lg bg-muted p-2">
      <input
        autoFocus
        inputMode="decimal"
        aria-label="Descuento"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={unit === '%' ? '10' : '0.00'}
        className="h-9 w-24 rounded-lg border bg-background px-2 text-right tabular-nums"
      />
      <div className="flex rounded-lg border bg-background p-0.5" role="group" aria-label="Unidad">
        {(['Q', '%'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={unit === option}
            onClick={() => setUnit(option)}
            className={cn(
              'h-8 w-9 rounded-md text-sm font-semibold',
              unit === option && 'bg-primary text-primary-foreground',
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <Button type="submit" className="min-h-9 px-3">
        Aplicar
      </Button>
      {currentCents > 0 && (
        <Button type="button" variant="ghost" className="min-h-9 px-2" onClick={() => onApply(0)}>
          Quitar
        </Button>
      )}
    </form>
  );
}
