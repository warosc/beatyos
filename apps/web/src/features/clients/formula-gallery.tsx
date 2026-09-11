'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { usePagedList } from '@/lib/use-paged-list';
import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';

type PhotoKind = 'BEFORE' | 'AFTER' | 'REFERENCE' | 'FORMULA' | 'OTHER';
type Photo = {
  id: string;
  kind: PhotoKind;
  caption: string | null;
  notes: string | null;
  takenAt: string;
  url: string;
};

const KIND_LABEL: Record<PhotoKind, string> = {
  FORMULA: 'Fórmula',
  BEFORE: 'Antes',
  AFTER: 'Después',
  REFERENCE: 'Referencia',
  OTHER: 'Otro',
};

// Refleja PHOTO_MAX_BYTES del backend (.env): avisa antes de subir en vez de esperar el 422.
const MAX_BYTES = 10 * 1024 * 1024;

export function FormulaGallery({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);
  const photos = usePagedList<Photo>(
    'client-photos',
    `/api/clients/${encodeURIComponent(clientId)}/photos?limit=12&page=${page}`,
  );
  const refresh = async () => {
    setAdding(false);
    setSelected(null);
    await qc.invalidateQueries({ queryKey: ['client-photos'] });
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Can permission="clients.update">
          <Button onClick={() => setAdding(true)}>
            <ImagePlus size={17} />
            Agregar
          </Button>
        </Can>
      </div>
      {photos.isPending && <p role="status">Cargando galería…</p>}
      {photos.error && (
        <p role="alert">
          No se pudo cargar la galería.{' '}
          <button onClick={() => photos.refetch()}>Reintentar</button>
        </p>
      )}
      {!photos.isPending && !photos.error && !photos.data?.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Todavía no hay fotos ni fórmulas guardadas.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {photos.data?.map((photo) => (
          <button key={photo.id} onClick={() => setSelected(photo)} className="text-left">
            <Card className="overflow-hidden p-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- viene de una URL firmada de MinIO, no de /public */}
              <img
                src={photo.url}
                alt={photo.caption ?? KIND_LABEL[photo.kind]}
                className="aspect-square w-full object-cover"
              />
              <div className="p-2">
                <p className="truncate text-xs font-semibold">{KIND_LABEL[photo.kind]}</p>
                {photo.caption && (
                  <p className="truncate text-xs text-muted-foreground">{photo.caption}</p>
                )}
              </div>
            </Card>
          </button>
        ))}
      </div>
      <Pagination meta={photos.meta} pending={photos.isFetching} onPage={setPage} />
      {adding && (
        <UploadForm clientId={clientId} onClose={() => setAdding(false)} onSaved={refresh} />
      )}
      {selected && (
        <PhotoDetail
          clientId={clientId}
          photo={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function UploadForm({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const file = f.get('file') as File | null;
    if (!file || file.size === 0) {
      setError('Selecciona una foto.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`La foto ocupa más de ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setBusy(true);
    const body = new FormData();
    body.append('file', file);
    // El consentimiento se pide en el momento, en el salón: no hace falta un selector de
    // fuente para el caso real de uso.
    body.append('consentGivenAt', new Date().toISOString());
    body.append('consentSource', 'IN_PERSON');
    body.append('kind', String(f.get('kind')));
    const caption = String(f.get('caption') ?? '').trim();
    if (caption) body.append('caption', caption);
    const notes = String(f.get('notes') ?? '').trim();
    if (notes) body.append('notes', notes);

    const r = await sessionFetch(`/api/clients/${encodeURIComponent(clientId)}/photos`, {
      method: 'POST',
      body,
    });
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json().catch(() => ({}))) as { detail?: string };
      setError(p.detail ?? 'No pudimos guardar la foto.');
      return;
    }
    onSaved();
  }

  const input = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Agregar foto"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center"
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between">
          <h2 className="font-display text-2xl font-semibold">Agregar foto</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
        <label className="block text-sm font-semibold">
          Foto
          <input
            required
            type="file"
            name="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={(e) => {
              const file = e.target.files?.[0];
              setPreview((old) => {
                if (old) URL.revokeObjectURL(old);
                return file ? URL.createObjectURL(file) : null;
              });
            }}
            className={input}
          />
        </label>
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element -- previsualización local, sin optimizar
          <img src={preview} alt="" className="max-h-56 rounded-xl object-contain" />
        )}
        <label className="block text-sm font-semibold">
          Tipo
          <select name="kind" defaultValue="FORMULA" className={input}>
            {(Object.keys(KIND_LABEL) as PhotoKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold">
          Fórmula / leyenda
          <input
            name="caption"
            placeholder="Ej. Base 7 + 30ml oxidante 20vol"
            className={input}
          />
        </label>
        <label className="block text-sm font-semibold">
          Notas técnicas
          <textarea name="notes" rows={3} className={`${input} h-auto py-3`} />
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input required type="checkbox" name="consent" className="mt-0.5 size-5" />
          La clienta autorizó guardar esta foto
        </label>
        <p className="text-xs text-muted-foreground">
          Máximo {MAX_BYTES / 1024 / 1024} MB. JPEG, PNG, WebP o HEIC.
        </p>
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
        </div>
      </form>
    </div>
  );
}

function PhotoDetail({
  clientId,
  photo,
  onClose,
  onChanged,
}: {
  clientId: string;
  photo: Photo;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useAccess();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function saveDescription(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    const r = await sessionFetch(
      `/api/clients/${encodeURIComponent(clientId)}/photos/${photo.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: f.get('kind'),
          caption: f.get('caption') || null,
          notes: f.get('notes') || null,
        }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json().catch(() => ({}))) as { detail?: string };
      setError(p.detail ?? 'No pudimos guardar los cambios.');
      return;
    }
    onChanged();
  }

  async function remove() {
    if (!window.confirm('¿Eliminar esta foto?')) return;
    setBusy(true);
    setError('');
    const r = await sessionFetch(
      `/api/clients/${encodeURIComponent(clientId)}/photos/${photo.id}`,
      { method: 'DELETE' },
    );
    setBusy(false);
    if (!r.ok) {
      const p = (await r.json().catch(() => ({}))) as { detail?: string };
      setError(p.detail ?? 'No pudimos eliminar la foto.');
      return;
    }
    onChanged();
  }

  const input = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Detalle de foto"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="w-full max-w-lg space-y-4 rounded-2xl bg-card p-6">
        <div className="flex justify-between">
          <h2 className="font-display text-xl font-semibold">{KIND_LABEL[photo.kind]}</h2>
          <button onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- viene de una URL firmada de MinIO */}
        <img
          src={photo.url}
          alt={photo.caption ?? ''}
          className="max-h-80 w-full rounded-xl object-contain"
        />
        {editing ? (
          <form onSubmit={saveDescription} className="space-y-3">
            <label className="block text-sm font-semibold">
              Tipo
              <select name="kind" defaultValue={photo.kind} className={input}>
                {(Object.keys(KIND_LABEL) as PhotoKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Fórmula / leyenda
              <input name="caption" defaultValue={photo.caption ?? ''} className={input} />
            </label>
            <label className="block text-sm font-semibold">
              Notas técnicas
              <textarea
                name="notes"
                rows={3}
                defaultValue={photo.notes ?? ''}
                className={`${input} h-auto py-3`}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
              <Button disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</Button>
            </div>
          </form>
        ) : (
          <>
            {photo.caption && <p className="text-sm font-semibold">{photo.caption}</p>}
            {photo.notes && <p className="text-sm text-muted-foreground">{photo.notes}</p>}
            <p className="text-xs text-muted-foreground">
              {new Intl.DateTimeFormat('es-GT', { dateStyle: 'long' }).format(
                new Date(photo.takenAt),
              )}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        {!editing && can('clients.update') && (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              Editar
            </Button>
            <Button variant="outline" className="text-danger" disabled={busy} onClick={remove}>
              <Trash2 size={16} />
              Eliminar
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
