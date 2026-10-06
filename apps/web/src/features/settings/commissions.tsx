'use client';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ServiceCreator,
  ServiceEditor,
  type CatalogService,
} from '@/features/settings/service-form';
import { sessionFetch } from '@/lib/session-fetch';
import { loadOptions } from '@/lib/pagination';
import { money } from '@/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { CalendarOff, Pencil, Trash2 } from 'lucide-react';

type Block = { id?: string; dayOfWeek: number; start: string; end: string };
type TimeOff = { id: string; startsAt: string; endsAt: string; reason: string | null };
type Stylist = {
  id: string;
  displayName: string;
  commissionRate: number;
  schedule: Block[];
  timeOff: TimeOff[];
  skills: Skill[];
};
type Skill = { serviceId: string; durationMinutes: number | null; commissionRate: number | null };
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
async function problem(r: Response, fallback: string) {
  const b = (await r.json().catch(() => ({}))) as { detail?: string; message?: string };
  return b.detail ?? b.message ?? fallback;
}

export function Commissions() {
  const { can } = useAccess();
  const qc = useQueryClient();
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<CatalogService | null>(null);
  const stylists = useQuery({
    queryKey: ['commission-stylists'],
    enabled: can('stylists.read') || can('stylists.update'),
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const services = useQuery({
    queryKey: ['commission-services'],
    enabled: can('services.read') || can('services.update'),
    queryFn: ({ signal }) => loadOptions<CatalogService>('/api/agenda?resource=services', signal),
  });
  const refreshServices = () => qc.invalidateQueries({ queryKey: ['commission-services'] });
  async function removeService(service: CatalogService) {
    if (
      !confirm(
        `¿Eliminar «${service.name}»? Ya no se podrá agendar ni cobrar. Las ventas ya hechas no cambian.`,
      )
    )
      return;
    setNotice('');
    const r = await sessionFetch(`/api/services/${encodeURIComponent(service.id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) return setNotice(await problem(r, 'No pudimos eliminar el servicio.'));
    setNotice(`«${service.name}» se eliminó.`);
    await refreshServices();
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
      {can('services.create') && <ServiceCreator onCreated={refreshServices} />}
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Servicios</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cambia el precio, la duración o la comisión, o elimina lo que el salón ya no ofrece.
        </p>
        {services.data?.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">Todavía no hay servicios.</p>
        )}
        <ul className="mt-3 divide-y">
          {services.data?.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{x.name}</p>
                <p className="text-sm text-muted-foreground">
                  {money(x.priceWithTax)} · {x.durationMinutes} min
                  {x.bufferMinutes > 0 && ` + ${x.bufferMinutes} de limpieza`} · Comisión:{' '}
                  {x.commissionRate === null ? 'la de cada estilista' : `${x.commissionRate} %`}
                </p>
              </div>
              {can('services.update') && (
                <Button
                  variant="outline"
                  aria-label={`Editar ${x.name}`}
                  onClick={() => setEditing(x)}
                >
                  <Pencil size={16} />
                  Editar
                </Button>
              )}
              {can('services.delete') && (
                <Button
                  variant="ghost"
                  aria-label={`Eliminar ${x.name}`}
                  onClick={() => removeService(x)}
                >
                  <Trash2 size={16} />
                  Eliminar
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {editing && (
        <ServiceEditor
          service={editing}
          close={() => setEditing(null)}
          saved={async (name) => {
            setNotice(`«${name}» se actualizó.`);
            await refreshServices();
          }}
        />
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
      {can('stylists.update') && (
        <SkillsManager stylists={stylists.data ?? []} services={services.data ?? []} />
      )}
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

/**
 * Servicios que cada estilista puede realizar.
 *
 * Es lo que la estilista verá al registrar un servicio en su perfil, y lo que la agenda usa
 * para ofrecerla. Sin ninguno marcado puede hacerlo todo, igual que en el servidor. Al
 * guardar se conservan la duración y la comisión propias que ya tuviera cada servicio.
 */
function SkillsManager({
  stylists,
  services,
}: {
  stylists: Stylist[];
  services: CatalogService[];
}) {
  const qc = useQueryClient();
  const [id, setId] = useState('');
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedId = id || stylists[0]?.id || '';
  const stylist = stylists.find((x) => x.id === selectedId);
  const current = chosen ?? stylist?.skills.map((skill) => skill.serviceId) ?? [];

  function toggle(serviceId: string) {
    setMessage('');
    setChosen(
      current.includes(serviceId)
        ? current.filter((x) => x !== serviceId)
        : [...current, serviceId],
    );
  }

  async function save() {
    setBusy(true);
    const previous = new Map(stylist?.skills.map((skill) => [skill.serviceId, skill]));
    const r = await sessionFetch(`/api/stylists/${selectedId}/skills`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: current.map((serviceId) => ({
          serviceId,
          durationMinutes: previous.get(serviceId)?.durationMinutes ?? null,
          commissionRate: previous.get(serviceId)?.commissionRate ?? null,
        })),
      }),
    });
    setBusy(false);
    setMessage(
      r.ok ? 'Servicios asignados.' : await problem(r, 'No pudimos guardar los servicios.'),
    );
    if (r.ok) {
      setChosen(null);
      await qc.invalidateQueries({ queryKey: ['commission-stylists'] });
    }
  }

  return (
    <Card className="p-6">
      <h2 className="font-display text-xl font-semibold">Servicios por estilista</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Marca los servicios que cada estilista realiza. Son los que podrá registrar desde su perfil
        para que caja los cobre. Sin ninguno marcado, puede registrar cualquiera.
      </p>
      <select
        aria-label="Estilista"
        value={selectedId}
        onChange={(e) => {
          setId(e.target.value);
          setChosen(null);
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
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {services.map((service) => (
          <label
            key={service.id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm"
          >
            <input
              type="checkbox"
              checked={current.includes(service.id)}
              onChange={() => toggle(service.id)}
            />
            <span>
              <span className="block font-medium">{service.name}</span>
              <span className="text-xs text-muted-foreground">
                {service.durationMinutes} min · {money(service.priceWithTax)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={!selectedId || busy} onClick={save}>
          {busy ? 'Guardando…' : 'Guardar servicios'}
        </Button>
        {current.length === 0 && (
          <span className="text-sm text-muted-foreground">Puede registrar cualquier servicio.</span>
        )}
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </Card>
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
