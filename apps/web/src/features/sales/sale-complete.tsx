'use client';
import { CheckCircle2, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDialog } from '@/lib/use-dialog';
import { money } from '@/lib/utils';

/**
 * Confirmación tras cobrar. El vuelto va en grande: es lo que la cajera tiene que contar
 * mientras la clienta espera. Enter o Escape empiezan la venta siguiente; P abre el
 * comprobante.
 */
export function SaleComplete({
  number,
  totalCents,
  changeCents,
  onNext,
  onPrint,
}: {
  number: string;
  totalCents: number;
  changeCents: number;
  onNext: () => void;
  onPrint?: () => void;
}) {
  const dialogRef = useDialog(onNext);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Venta completada"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 text-center">
        <CheckCircle2 size={44} className="mx-auto text-success" />
        <div>
          <h2 role="status" className="font-display text-2xl font-semibold">
            Venta {number} completada
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Cobrado {money(totalCents / 100)}</p>
        </div>
        {changeCents > 0 && (
          <div className="rounded-xl bg-success/10 p-4 text-success">
            <p className="text-sm font-semibold">Vuelto</p>
            <p className="text-4xl font-bold tabular-nums">{money(changeCents / 100)}</p>
          </div>
        )}
        {onPrint && (
          <Button
            variant="outline"
            className="h-11 w-full"
            onClick={onPrint}
            onKeyDown={(event) => event.key.toLowerCase() === 'p' && onPrint()}
          >
            <Printer size={16} />
            Imprimir comprobante
          </Button>
        )}
        <Button
          data-autofocus
          className="h-12 w-full"
          onClick={onNext}
          onKeyDown={(event) => event.key.toLowerCase() === 'p' && onPrint?.()}
        >
          Nueva venta
          <kbd className="ml-1 rounded border border-primary-foreground/40 px-1.5 text-xs font-normal">
            Enter
          </kbd>
        </Button>
      </div>
    </div>
  );
}
