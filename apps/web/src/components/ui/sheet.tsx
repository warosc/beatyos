'use client';
import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useDialog } from '@/lib/use-dialog';
import { cn } from '@/lib/utils';

/**
 * Hoja de acciones: sube desde abajo en el móvil y es un diálogo centrado en pantalla grande.
 *
 * En el teléfono, lo que se pulsa tiene que quedar al alcance del pulgar: por eso la hoja
 * se pega al borde inferior, su cabecera y su pie no se desplazan con el contenido, y el
 * botón principal queda siempre a la vista aunque el formulario sea largo.
 */
export function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  tall = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  /**
   * Altura fija en lugar de ajustarse al contenido. Para asistentes de varios pasos: la hoja
   * no salta de tamaño entre pasos y las listas desplegables tienen sitio.
   */
  tall?: boolean;
}) {
  const ref = useDialog(onClose);
  const titleId = useId();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        // Tocar fuera cierra, como cualquier hoja del sistema. Solo si el toque empezó
        // fuera: arrastrar una selección de texto hasta el borde no debe cerrarla.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-card shadow-xl sm:rounded-2xl',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          tall && 'h-[92dvh] sm:h-[min(760px,92dvh)]',
        )}
      >
        <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-border sm:hidden" />
        <header className="flex items-start gap-3 border-b px-5 pt-3 pb-4 sm:pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-display text-2xl font-semibold">
              {title}
            </h2>
            {description && (
              <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-muted"
          >
            <X />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="border-t px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
