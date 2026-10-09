'use client';
import { useEffect, useRef } from 'react';

/**
 * Focus containment, Escape, and restoration for existing modal forms.
 *
 * Al abrir, el foco va al elemento marcado con `data-autofocus` si lo hay; si no, al
 * primero que se pueda enfocar. La marca existe porque el primero no siempre es el que
 * toca: tras cobrar, Enter tiene que empezar la venta siguiente, no imprimir.
 */
export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const selector =
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]';
    const elements = () =>
      Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.getClientRects().length > 0,
      );
    (root.querySelector<HTMLElement>('[data-autofocus]') ?? elements()[0] ?? root).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const all = elements();
        const first = all[0];
        const last = all.at(-1);
        if (!first) {
          event.preventDefault();
          root.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || !root.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !root.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const focus = (event: FocusEvent) => {
      if (!root.contains(event.target as Node)) (elements()[0] ?? root).focus();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return ref;
}
