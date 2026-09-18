'use client';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { sessionFetch } from '@/lib/session-fetch';
import { loadOptions } from '@/lib/pagination';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';

type Block = { id?: string; dayOfWeek: number; start: string; end: string };
type TimeOff = { id: string; startsAt: string; endsAt: string; reason: string | null };
type Stylist = {
  id: string;
  displayName: string;
  commissionRate: number;
  schedule: Block[];
  timeOff: TimeOff[];
};
type Service = {
  id: string;
  name: string;
  commissionRate: number | null;
  durationMinutes: number;
  price: string;
  currency: string;
};
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
async function problem(r: Response, fallback: string) {
  const b = (await r.json().catch(() => ({}))) as { detail?: string; message?: string };
  return b.detail ?? b.message ?? fallback;
}

export function Commissions() {
  const { can } = useAccess();
  const qc = useQueryClient();
  const [notice, setNotice] = useState('');
  const stylists = useQuery({
    queryKey: ['commission-stylists'],
    enabled: can('stylists.read') || can('stylists.update'),
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const services = useQuery({
    queryKey: ['commission-services'],
    enabled: can('services.read') || can('services.update'),
    queryFn: ({ signal }) => loadOptions<Service>('/api/agenda?resource=services', signal),
  });
  async function createService(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNotice('');
    const form = e.currentTarget,
      d = new FormData(form);
    const r = await sessionFetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: d.get('code'),
        name: d.get('name'),
        durationMinutes: Number(d.get('duration')),
        price: Number(d.get('price')).toFixed(2),
        bufferMinutes: Number(d.get('buffer') || 0),
        commissionRate: d.get('commission') === '' ? null : Number(d.get('commission')),
      }),
    });
    if (!r.ok) return setNotice(await problem(r, 'No pudimos crear el servicio.'));
    form.reset();
    setNotice('Servicio creado correctamente.');
    await qc.invalidateQueries({ queryKey: ['commission-services'] });
  }
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Equipo y catálogo</p>
        <h1 className="mt-1 font-display text-4xl font-semibold">Comisiones y jornadas</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Administra porcentajes, servicios, horarios semanales y ausencias.
        </p>
      </div>
      {notice && (
        <p role="status" className="rounded-xl bg-secondary p-3 text-sm">
          {notice}
        </p>
      )}
      {can('services.create') && (
        <Card className="p-6">
          <h2 className="font-display text-xl font-semibold">Agregar servicio</h2>
          <form onSubmit={createService} className="mt-4 grid gap-3 md:grid-cols-3">
            <Field name="code" label="Código" placeholder="CORTE-M" />
            <Field name="name" label="Nombre" />
            <Field name="duration" label="Duración (min)" type="number" />
            <Field name="price" label="Precio sin impuesto" type="number" step="0.01" />
            <Field name="buffer" label="Margen posterior (min)" type="number" required={false} />
            <Field
              name="commission"
              label="Comisión propia (%)"
              type="number"
              step="0.01"
              required={false}
            />
            <Button className="md:col-span-3">
              <Plus size={17} />
              Crear servicio
            </Button>
          </form>
        </Card>
      )}
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Por estilista</h2>
        <div className="mt-3 divide-y">
          {stylists.data?.map((x) => (
            <CommissionRow
              key={x.id}
              id={x.id}
              name={x.displayName}
              rate={x.commissionRate}
              resource="stylists"
              queryKey="commission-stylists"
              editable={can('stylists.update')}
              nullable={false}
            />
          ))}
        </div>
      </Card>
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Servicios activos</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ajusta la comisión o retira un servicio que el negocio ya no ofrece.
        </p>
        <div className="mt-3 divide-y">
          {services.data?.map((x) => (
            <div key={x.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <CommissionRow
                  id={x.id}
                  name={`${x.name} · ${x.durationMinutes} min · ${x.price} ${x.currency}`}
                  rate={x.commissionRate}
                  resource="services"
                  queryKey="commission-services"
                  editable={can('services.update')}
                  nullable
                />
              </div>
              {can('services.delete') && (
                <Button
                  variant="ghost"
                  aria-label={`Retirar ${x.name}`}
                  onClick={async () => {
                    if (!confirm(`¿Retirar ${x.name} del catálogo?`)) return;
                    const r = await sessionFetch(`/api/services/${x.id}`, { method: 'DELETE' });
                    if (!r.ok)
                      return setNotice(await problem(r, 'No pudimos retirar el servicio.'));
                    await qc.invalidateQueries({ queryKey: ['commission-services'] });
                  }}
                >
                  <Trash2 size={17} />
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
      {can('stylists.manage-schedule') && <ScheduleManager stylists={stylists.data ?? []} />}{' '}
    </div>
  );
}
function Field({
  name,
  label,
  type = 'text',
  step,
  placeholder,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  step?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="text-sm font-semibold">
      {label}
      <input
        name={name}
        type={type}
        step={step}
        placeholder={placeholder}
        required={required}
        min={type === 'number' ? '0' : undefined}
        className="mt-1 h-11 w-full rounded-xl border bg-background px-3"
      />
    </label>
  );
}

function ScheduleManager({ stylists }: { stylists: Stylist[] }) {
  const qc = useQueryClient();
  const [id, setId] = useState('');
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [message, setMessage] = useState('');
  const selectedId = id || stylists[0]?.id || '';
  const stylist = stylists.find((x) => x.id === selectedId);
  const currentBlocks = blocks ?? stylist?.schedule ?? [];
  const row = (day: number) => currentBlocks.find((x) => x.dayOfWeek === day);
  function change(day: number, field: 'enabled' | 'start' | 'end', value: string | boolean) {
    setMessage('');
    setBlocks((old) => {
      const existing = old ?? stylist?.schedule ?? [];
      if (field === 'enabled')
        return value
          ? [...existing, { dayOfWeek: day, start: '09:00', end: '18:00' }]
          : existing.filter((x) => x.dayOfWeek !== day);
      return existing.map((x) => (x.dayOfWeek === day ? { ...x, [field]: value } : x));
    });
  }
  async function save() {
    const r = await sessionFetch(`/api/stylists/${selectedId}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: currentBlocks.map(({ dayOfWeek, start, end }) => ({ dayOfWeek, start, end })),
      }),
    });
    setMessage(r.ok ? 'Jornada guardada.' : await problem(r, 'No pudimos guardar la jornada.'));
    if (r.ok) await qc.invalidateQueries({ queryKey: ['commission-stylists'] });
  }
  async function addOff(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      d = new FormData(form);
    const start = new Date(`${d.get('from')}T00:00:00`),
      end = new Date(`${d.get('to')}T23:59:59`);
    const r = await sessionFetch(`/api/stylists/${selectedId}/time-off`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        reason: d.get('reason') || null,
      }),
    });
    setMessage(
      r.ok ? 'Ausencia registrada.' : await problem(r, 'No pudimos registrar la ausencia.'),
    );
    if (r.ok) {
      form.reset();
      await qc.invalidateQueries({ queryKey: ['commission-stylists'] });
    }
  }
  async function removeOff(offId: string) {
    const r = await sessionFetch(`/api/stylists/${selectedId}/time-off/${offId}`, {
      method: 'DELETE',
    });
    setMessage(r.ok ? 'Ausencia eliminada.' : await problem(r, 'No pudimos eliminarla.'));
    if (r.ok) await qc.invalidateQueries({ queryKey: ['commission-stylists'] });
  }
  return (
    <Card className="p-6">
      <h2 className="font-display text-xl font-semibold">Jornada por estilista</h2>
      <select
        value={selectedId}
        onChange={(e) => {
          setId(e.target.value);
          setBlocks(stylists.find((item) => item.id === e.target.value)?.schedule ?? []);
          setMessage('');
        }}
        className="mt-4 h-11 w-full rounded-xl border bg-background px-3"
      >
        {stylists.map((x) => (
          <option key={x.id} value={x.id}>
            {x.displayName}
          </option>
        ))}
      </select>
      <div className="mt-4 space-y-2">
        {DAYS.map((name, day) => {
          const b = row(day);
          return (
            <div
              key={name}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-xl border p-3"
            >
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={!!b}
                  onChange={(e) => change(day, 'enabled', e.target.checked)}
                />
                {name}
              </label>
              <input
                aria-label={`Inicio ${name}`}
                disabled={!b}
                type="time"
                value={b?.start ?? '09:00'}
                onChange={(e) => change(day, 'start', e.target.value)}
                className="h-10 rounded-lg border bg-background px-2"
              />
              <input
                aria-label={`Fin ${name}`}
                disabled={!b}
                type="time"
                value={b?.end ?? '18:00'}
                onChange={(e) => change(day, 'end', e.target.value)}
                className="h-10 rounded-lg border bg-background px-2"
              />
            </div>
          );
        })}
      </div>
      <Button className="mt-4" disabled={!selectedId} onClick={save}>
        Guardar jornada
      </Button>
      <div className="my-6 border-t" />
      <h3 className="font-semibold">Vacaciones, descansos y ausencias</h3>
      <form onSubmit={addOff} className="mt-3 grid gap-3 md:grid-cols-3">
        <Field name="from" label="Desde" type="date" />
        <Field name="to" label="Hasta" type="date" />
        <Field name="reason" label="Motivo" required={false} />
        <Button className="md:col-span-3">
          <CalendarOff size={17} />
          Registrar ausencia
        </Button>
      </form>
      <div className="mt-4 space-y-2">
        {stylist?.timeOff.map((x) => (
          <div
            key={x.id}
            className="flex items-center justify-between rounded-xl bg-muted p-3 text-sm"
          >
            <span>
              {new Date(x.startsAt).toLocaleDateString('es-GT')} –{' '}
              {new Date(x.endsAt).toLocaleDateString('es-GT')} · {x.reason ?? 'Ausencia'}
            </span>
            <Button variant="ghost" onClick={() => removeOff(x.id)}>
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </Card>
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
  nullable: boolean;
}) {
  const qc = useQueryClient();
  const initial = rate === null ? '' : String(rate);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    const r = await sessionFetch(`/api/${resource}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commissionRate: value === '' ? null : Number(value) }),
    });
    setBusy(false);
    if (!r.ok) return setError(await problem(r, 'No pudimos guardar la comisión.'));
    await qc.invalidateQueries({ queryKey: [queryKey] });
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <p className="font-medium">{name}</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder={nullable ? 'De la estilista' : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!editable}
          className="h-10 w-32 rounded-lg border bg-background px-3 text-right text-sm"
        />
        <span>%</span>
        {editable && (
          <Button
            variant="outline"
            disabled={busy || value === initial || (value === '' && !nullable)}
            onClick={save}
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
