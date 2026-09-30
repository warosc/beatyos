'use client';
import { useEffect, useRef } from 'react';

/**
 * Atajos del punto de venta, pensados para cobrar sin soltar el teclado:
 * `/` lleva a la búsqueda y `F2` (o `Ctrl+Enter`) abre el cobro.
 *
 * Con un diálogo abierto no hacen nada: ahí manda el diálogo.
 */
export function usePosShortcuts(handlers: { onSearch: () => void; onCharge: () => void }) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');

      if (event.key === '/' && !typing) {
        event.preventDefault();
        latest.current.onSearch();
      } else if (
        event.key === 'F2' ||
        (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        latest.current.onCharge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
