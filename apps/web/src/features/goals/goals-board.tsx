'use client';
import { useDialog } from '@/lib/use-dialog';
import { useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { usePagedList } from '@/lib/use-paged-list';
import { loadOptions } from '@/lib/pagination';
import { Pagination } from '@/components/ui/pagination';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trophy, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Metric = 'SERVICE_REVENUE' | 'PRODUCT_REVENUE';
type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'EXPIRED';
type GoalItem = {
  id: string;
  stylistId: string;
  metric: Metric;
  targetAmount: string;
  progress: string;
  percentage: number;
  periodStart: string;
  periodEnd: string;
  rewardDescription: string;
  status: GoalStatus;
};
type Stylist = { id: string; displayName: string };

const METRIC_LABEL: Record<Metric, string> = {
  SERVICE_REVENUE: 'Servicios',
  PRODUCT_REVENUE: 'Productos',
};

const money = (amount: string) =>
  new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' }).format(Number(amount));

export function GoalsBoard() {
  const { can } = useAccess();
  const canCreate = can('goals.create');
  const canDelete = can('goals.delete');
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const goals = usePagedList<GoalItem>('goals', `/api/goals?limit=20&page=${page}`);
  const stylists = useQuery({
    queryKey: ['stylists'],
    enabled: can('stylists.read'),
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const stylistName = (id: string) => stylists.data?.find((s) => s.id === id)?.displayName ?? 'Tú';

  const refresh = async () => {
    setCreating(false);
    await qc.invalidateQueries({ queryKey: ['goals'] });
  };

  async function cancelGoal(id: string) {
    if (!window.confirm('¿Cancelar esta meta?')) return;
    await sessionFetch(`/api/goals/${id}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Equipo</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Metas</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Objetivos de facturación por profesional, con su recompensa.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} />
            Nueva meta
          </Button>
        )}
      </div>
      {goals.isPending && <p role="status">Cargando metas…</p>}
      {goals.error && (
        <p role="alert">
          No se pudieron cargar las metas.{' '}
          <button onClick={() => goals.refetch()}>Reintentar</button>
        </p>
      )}
      {!goals.isPending && !goals.error && !goals.data?.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Todavía no hay metas definidas.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {goals.data?.map((goal) => (
          <Card key={goal.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {METRIC_LABEL[goal.metric]}
                </p>
                <h2 className="mt-1 font-display text-lg font-semibold">
                  {stylistName(goal.stylistId)}
                </h2>
              </div>
              <Trophy
                className={goal.status === 'ACHIEVED' ? 'text-warning' : 'text-muted-foreground/30'}
                size={28}
                fill={goal.status === 'ACHIEVED' ? 'currentColor' : 'none'}
              />
            </div>
            <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${goal.status === 'ACHIEVED' ? 'bg-warning' : 'bg-primary'}`}
                style={{ width: `${goal.percentage}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>
                {money(goal.progress)} / {money(goal.targetAmount)}
              </span>
              <span>{goal.percentage}%</span>
            </div>
            <div className="mt-4 border-t pt-3">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Recompensa
              </p>
              <p className="mt-1 text-sm">{goal.rewardDescription}</p>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {new Date(goal.periodStart).toLocaleDateString('es-GT')} –{' '}
              {new Date(goal.periodEnd).toLocaleDateString('es-GT')}
            </p>
            {goal.status === 'EXPIRED' && (
              <p className="mt-2 text-xs font-semibold text-danger">Periodo vencido</p>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                className="mt-3 w-full text-danger"
                onClick={() => cancelGoal(goal.id)}
              >
                Cancelar meta
              </Button>
            )}
          </Card>
        ))}
      </div>
      <Pagination meta={goals.meta} pending={goals.isFetching} onPage={setPage} />
      {creating && (
        <GoalForm
          stylists={stylists.data ?? []}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function GoalForm({
  stylists,
  onClose,
  onSaved,
}: {
  stylists: Stylist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const body = {
      stylistId: data.get('stylistId'),
      metric: data.get('metric'),
      targetAmount: Number(data.get('targetAmount')),
      periodStart: new Date(`${String(data.get('periodStart'))}T00:00:00`).toISOString(),
      periodEnd: new Date(`${String(data.get('periodEnd'))}T23:59:59`).toISOString(),
      rewardDescription: data.get('rewardDescription'),
    };
    const response = await sessionFetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        detail?: string;
        errors?: { message: string }[];
      };
      setError(
        problem.errors?.map((item) => item.message).join('. ') ??
          problem.detail ??
          'No pudimos guardar la meta.',
      );
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
      aria-label="Nueva meta"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center"
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between">
          <h2 className="font-display text-2xl font-semibold">Nueva meta</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
        <label className="block text-sm font-semibold">
          Estilista
          <select required name="stylistId" className={input}>
            <option value="">Selecciona…</option>
            {stylists.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold">
          Tipo de meta
          <select required name="metric" className={input}>
            <option value="SERVICE_REVENUE">Facturación de servicios</option>
            <option value="PRODUCT_REVENUE">Facturación de productos</option>
          </select>
        </label>
        <label className="block text-sm font-semibold">
          Objetivo (Q)
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            name="targetAmount"
            className={input}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold">
            Desde
            <input required type="date" name="periodStart" className={input} />
          </label>
          <label className="block text-sm font-semibold">
            Hasta
            <input required type="date" name="periodEnd" className={input} />
          </label>
        </div>
        <label className="block text-sm font-semibold">
          Recompensa
          <input
            required
            name="rewardDescription"
            placeholder="Ej. Gift card Q200 Walmart"
            className={input}
          />
        </label>
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
