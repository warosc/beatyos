'use client';
import { X } from 'lucide-react';

/**
 * Botón de cerrar de los diálogos: 44 px para el dedo, con nombre para el lector de
 * pantalla y `type="button"` para que, dentro de un formulario, no lo envíe.
 */
export function DialogClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Cerrar"
      onClick={onClose}
      className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X size={20} />
    </button>
  );
}
