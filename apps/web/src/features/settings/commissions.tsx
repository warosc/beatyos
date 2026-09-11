'use client';
import { useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { loadOptions } from '@/lib/pagination';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Stylist = { id: string; displayName: string; commissionRate: number };
type Service = { id: string; name: string; commissionRate: number | null };

export function Commissions() {
  const { can } = useAccess();
  const canEditStylists = can('stylists.update');
  const canEditServices = can('services.update');
  const stylists = useQuery({
    queryKey: ['commission-stylists'],
    enabled: can('stylists.read') || canEditStylists,
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const services = useQuery({
    queryKey: ['commission-services'],
    enabled: can('services.read') || canEditServices,
    queryFn: ({ signal }) => loadOptions<Service>('/api/agenda?resource=services', signal),
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Equipo y catálogo</p>
        <h1 className="mt-1 font-display text-4xl font-semibold">Comisiones</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          La comisión de una estilista aplica a cada venta que hace; un servicio puede fijar la
          suya propia y sobrescribirla.
        </p>
      </div>
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Por estilista</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Comisión general. Se usa siempre que el servicio no tenga una propia, y en toda venta
          de producto.
        </p>
        {stylists.isPending && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Cargando…
          </p>
        )}
        {stylists.error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            No se pudo cargar el equipo.
          </p>
        )}
        <div className="mt-3 divide-y">
          {stylists.data?.map((item) => (
            <CommissionRow
              key={item.id}
              id={item.id}
              name={item.displayName}
              rate={item.commissionRate}
              resource="stylists"
              queryKey="commission-stylists"
              editable={canEditStylists}
              nullable={false}
            />
          ))}
        </div>
      </Card>
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Por servicio</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sobrescribe la comisión de la estilista para este servicio en particular. Vacío usa la
          suya.
        </p>
        {services.isPending && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Cargando…
          </p>
        )}
        {services.error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            No se pudo cargar el catálogo.
          </p>
        )}
        <div className="mt-3 divide-y">
          {services.data?.map((item) => (
            <CommissionRow
              key={item.id}
              id={item.id}
              name={item.name}
              rate={item.commissionRate}
              resource="services"
              queryKey="commission-services"
              editable={canEditServices}
              nullable
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function CommissionRow({
  id,
  name,
  rate,
  resource,
  queryKey,
  editable,
  nullable,
}: {
  id: string;
  name: string;
  rate: number | null;
  resource: 'stylists' | 'services';
  queryKey: string;
  editable: boolean;
  /** Servicios admiten borrar la comisión propia (vuelve a usar la de la estilista); una estilista siempre necesita la suya. */
  nullable: boolean;
}) {
  const qc = useQueryClient();
  const initial = rate === null ? '' : String(rate);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty = value !== initial;
  const invalid = value === '' && !nullable;

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    const commissionRate = value === '' ? null : Number(value);
    const response = await sessionFetch(`/api/${resource}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commissionRate }),
    });
    setBusy(false);
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as { detail?: string };
      setError(problem.detail ?? 'No pudimos guardar la comisión.');
      return;
    }
    setSaved(true);
    await qc.invalidateQueries({ queryKey: [queryKey] });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <p className="font-medium">{name}</p>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <input
            type="number"
            min="0"
            max="100"
            step="0.01"
            placeholder={nullable ? 'De la estilista' : undefined}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setSaved(false);
            }}
            disabled={!editable}
            aria-label={`Comisión de ${name}`}
            className="h-10 w-32 rounded-lg border bg-background px-3 text-right text-sm disabled:opacity-60"
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
        {editable && (
          <Button variant="outline" disabled={busy || !dirty || invalid} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        )}
        {saved && !dirty && <span className="text-xs text-success">Guardado</span>}
      </div>
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
