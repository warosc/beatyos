'use client';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Lo que no se pudo cargar, con su botón para volver a intentarlo.
 *
 * Un «Reintentar» como texto suelto no parece un botón: la gente recarga la página entera
 * y pierde lo que estaba haciendo.
 */
export function LoadError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger',
        className,
      )}
    >
      <span>{message}</span>
      <Button variant="outline" className="min-h-10 px-3" onClick={onRetry}>
        <RefreshCw size={15} />
        Reintentar
      </Button>
    </div>
  );
}

/** Una lista vacía que lo dice, en lugar de dejar la pantalla en blanco. */
export function EmptyState({
  title,
  hint,
  className,
}: {
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-dashed p-8 text-center', className)}>
      <p className="font-semibold">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
