'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, UserRound, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { loadPage } from '@/lib/pagination';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';

export type PosClient = {
  id: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  allergies?: string | null;
};

/**
 * Clienta de la venta, buscada en el servidor por nombre, teléfono o correo.
 *
 * Un `<select>` con todas las clientas deja de servir en cuanto el salón pasa de unas
 * decenas. Sin elegir a nadie, la venta es de «Clienta ocasional».
 *
 * Al enfocarlo ya lista las primeras clientas: un campo que no muestra nada hasta que se
 * escribe parece roto, y quien busca a una clienta habitual la encuentra sin teclear.
 */
export function ClientCombobox({
  value,
  onChange,
  placeholder = 'Clienta ocasional · buscar por nombre o teléfono',
  label = 'Clienta de la venta',
}: {
  value: PosClient | null;
  onChange: (client: PosClient | null) => void;
  placeholder?: string;
  /** Nombre accesible del buscador. */
  label?: string;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const search = useDebouncedValue(text.trim(), 250);
  // Con menos de dos letras no se busca: se ofrecen las primeras por orden alfabético.
  const term = search.length >= 2 ? search : '';
  const results = useQuery({
    queryKey: ['pos-clients', term],
    enabled: open,
    queryFn: ({ signal }) =>
      loadPage<PosClient>(
        `/api/agenda?resource=clients&limit=8&sort=name:asc${term ? `&search=${encodeURIComponent(term)}` : ''}`,
        signal,
      ).then((page) => page.data),
  });
  const options = results.data ?? [];

  function choose(client: PosClient) {
    onChange(client);
    setText('');
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (!options.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + options.length) % options.length);
    } else if (event.key === 'Enter' && open && options[active]) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'Escape' && (open || text)) {
      event.preventDefault();
      setOpen(false);
      setText('');
    }
  }

  if (value) {
    return (
      <div className="space-y-2">
        <div className="flex h-11 items-center gap-2 rounded-xl border bg-secondary px-3">
          <UserRound size={16} className="shrink-0 text-primary" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-semibold">{value.fullName}</p>
            {value.phone && <p className="truncate text-xs text-muted-foreground">{value.phone}</p>}
          </div>
          <button
            type="button"
            aria-label="Quitar clienta"
            onClick={() => onChange(null)}
            className="grid size-8 place-items-center rounded-lg hover:bg-muted"
          >
            <X size={16} />
          </button>
        </div>
        {value.allergies && (
          <p
            role="note"
            // En rojo, como en la ficha: es lo que no se puede pasar por alto antes de atender.
            className="flex items-start gap-2 rounded-lg bg-danger/10 p-2 text-xs font-medium text-danger"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong>Alergias:</strong> {value.allergies}
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        aria-label={label}
        placeholder={placeholder}
        className="h-11 w-full rounded-xl border bg-background px-3 text-sm"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-12 z-30 max-h-72 overflow-y-auto rounded-xl border bg-card p-1 shadow-lg"
        >
          {results.isPending ? (
            <li className="p-3 text-sm text-muted-foreground">Buscando…</li>
          ) : options.length ? (
            options.map((client, index) => (
              <li
                key={client.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                // `mousedown` y no `click`: el input pierde el foco antes del clic y cerraría
                // la lista sin elegir.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(client);
                }}
                className={cn(
                  'cursor-pointer rounded-lg px-3 py-2 text-sm',
                  index === active && 'bg-muted',
                )}
              >
                <p className="font-medium">{client.fullName}</p>
                <p className="text-xs text-muted-foreground">
                  {[client.phone, client.email].filter(Boolean).join(' · ') || 'Sin contacto'}
                </p>
              </li>
            ))
          ) : (
            <li className="p-3 text-sm text-muted-foreground">
              {term ? 'Ninguna clienta coincide.' : 'Aún no hay clientas registradas.'}
            </li>
          )}
          {!term && options.length > 0 && (
            <li aria-hidden className="border-t px-3 py-2 text-xs text-muted-foreground">
              Escribe para buscar entre todas las clientas.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
