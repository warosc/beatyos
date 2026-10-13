'use client';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Tv } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';
import { queueSend } from './types';

/**
 * Enlace de la pantalla de turnos para la TV de la sala.
 *
 * El enlace solo se enseña al crearlo: la API guarda su hash. Si se pierde, se crea otro, y
 * la pantalla que tuviera el anterior deja de mostrar la fila —que es también la forma de
 * cortar una pantalla que no debería verla—.
 */
export function DisplayLinkDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: ['queue', 'display-link'],
    queryFn: async () => {
      const response = await sessionFetch('/api/queue/display-link');
      if (!response.ok) throw new Error(await problem(response, 'No pudimos consultar el enlace.'));
      return ((await response.json()) as { data: { active: boolean } }).data;
    },
  });

  async function issue() {
    setBusy(true);
    setError('');
    const outcome = await queueSend<{ token: string }>(
      '/api/queue/display-link',
      {},
      'No pudimos crear el enlace.',
    );
    setBusy(false);
    if (!outcome.ok) return setError(outcome.error);
    setUrl(`${window.location.origin}/pantalla/${outcome.data.token}`);
    void status.refetch();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('No se pudo copiar. Selecciona el enlace y cópialo a mano.');
    }
  }

  return (
    <Sheet
      title="Pantalla de la TV"
      description="Muestra a quién se llama y con quién, con aviso sonoro. Solo el nombre corto y el número."
      onClose={onClose}
    >
      <div className="space-y-4">
        {url ? (
          <>
            <p className="text-sm">
              Abre este enlace en el navegador de la TV y pulsa <strong>Activar sonido</strong>.
              Guárdalo: por seguridad solo se enseña ahora.
            </p>
            <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
              Para la voz más natural, gratis: ábrelo con <strong>Microsoft Edge</strong> en una
              computadora con Windows y, en <strong>Voz</strong>, elige «Marta (Natural)» de
              Guatemala.
            </p>
            <input
              readOnly
              value={url}
              aria-label="Enlace de la pantalla"
              onFocus={(event) => event.currentTarget.select()}
              className="h-12 w-full rounded-xl border bg-muted px-3 font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={copy}>
                <Copy size={16} />
                {copied ? 'Copiado' : 'Copiar enlace'}
              </Button>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border bg-card px-4 text-sm font-semibold hover:bg-muted"
              >
                <ExternalLink size={16} />
                Abrir aquí
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="flex items-start gap-3 rounded-xl bg-muted p-4 text-sm">
              <Tv size={20} className="mt-0.5 shrink-0" />
              {status.isPending
                ? 'Comprobando…'
                : status.data?.active
                  ? 'Ya hay una pantalla con enlace. Si creas otro, la que tenga el anterior dejará de mostrar la fila.'
                  : 'Todavía no hay ninguna pantalla. Crea el enlace y ábrelo en la TV de la sala.'}
            </p>
            <Button className="h-12 w-full" disabled={busy || status.isPending} onClick={issue}>
              <Tv size={18} />
              {status.data?.active ? 'Crear un enlace nuevo' : 'Crear enlace'}
            </Button>
          </>
        )}
        {(error || status.error) && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error || status.error?.message}
          </p>
        )}
      </div>
    </Sheet>
  );
}
