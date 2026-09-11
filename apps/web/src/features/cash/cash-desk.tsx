'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calculator,
  CircleDollarSign,
  LockKeyhole,
  Plus,
} from 'lucide-react';
import { usePagedList } from '@/lib/use-paged-list';
import { Pagination } from '@/components/ui/pagination';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
type Session = {
  id: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  cashSales: string;
  expectedAmount: string;
  countedAmount: string | null;
  difference: string | null;
  currency: string;
  movements: { id: string; type: string; amount: string; concept: string; occurredAt: string }[];
};
async function call<T = Session>(resource: string, body?: Record<string, unknown>) {
  const r = await sessionFetch(
    `/api/cash?resource=${resource}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const p = (await r.json()) as { data?: T; detail?: string; message?: string };
  if (!r.ok) throw new Error(p.detail ?? p.message);
  return p.data ?? null;
}
export function CashDesk() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<'open' | 'movement' | 'close' | null>(null);
  const current = useQuery({ queryKey: ['cash'], queryFn: () => call('current') });
  const history = usePagedList<Session>(
    'cash-history',
    '/api/cash?resource=history&limit=20&page=' + page,
  );
  const session = current.data;
  const refresh = async () => {
    setAction(null);
    await qc.invalidateQueries({ queryKey: ['cash'] });
    await qc.invalidateQueries({ queryKey: ['cash-history'] });
  };
  if (current.isPending) return <p role="status">Cargando caja…</p>;
  if (current.error)
    return (
      <p role="alert">
        No se pudo consultar la caja. <button onClick={() => current.refetch()}>Reintentar</button>
      </p>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Control diario</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Caja</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Montos expresados en quetzales guatemaltecos.
          </p>
        </div>
        {session ? (
          <div className="flex gap-2">
            <Can permission="cash.movement">
              <Button variant="outline" onClick={() => setAction('movement')}>
                <Plus size={17} />
                Movimiento
              </Button>
            </Can>
            <Can permission="cash.close">
              <Button onClick={() => setAction('close')}>
                <LockKeyhole size={17} />
                Cerrar caja
              </Button>
            </Can>
          </div>
        ) : (
          <Can permission="cash.open">
            <Button onClick={() => setAction('open')}>
              <CircleDollarSign size={18} />
              Abrir caja
            </Button>
          </Can>
        )}
      </div>
      {session ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Fondo inicial" value={session.openingFloat} />
            <Metric label="Ventas en efectivo" value={session.cashSales} />
            <Metric label="Efectivo esperado" value={session.expectedAmount} />
            <Card className="p-5">
              <p className="text-sm text-muted-foreground">Estado</p>
              <p className="mt-3 flex items-center gap-2 text-xl font-bold text-success">
                <span className="size-2 rounded-full bg-success" />
                Abierta
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Desde{' '}
                {new Date(session.openedAt).toLocaleTimeString('es-GT', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </Card>
          </div>
          <Card className="overflow-hidden">
            <div className="border-b p-5">
              <h2 className="font-display text-xl font-semibold">Movimientos de efectivo</h2>
            </div>
            {session.movements.length ? (
              <div className="divide-y">
                {session.movements.map((m) => (
                  <div key={m.id} className="flex items-center gap-4 p-4">
                    <span
                      className={`grid size-10 place-items-center rounded-xl ${m.type === 'CASH_IN' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}
                    >
                      {m.type === 'CASH_IN' ? <ArrowDownLeft /> : <ArrowUpRight />}
                    </span>
                    <div className="flex-1">
                      <p className="font-semibold">{m.concept}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(m.occurredAt).toLocaleString('es-GT')}
                      </p>
                    </div>
                    <strong>
                      {m.type === 'CASH_IN' ? '+' : '-'} Q {m.amount}
                    </strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="p-10 text-center text-sm text-muted-foreground">
                Aún no hay movimientos manuales.
              </p>
            )}
          </Card>
        </>
      ) : (
        <Card className="grid min-h-80 place-items-center p-8 text-center">
          <div>
            <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-secondary text-primary">
              <Calculator size={28} />
            </span>
            <h2 className="mt-5 font-display text-2xl font-semibold">La caja está cerrada</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Abre un turno antes de aceptar pagos en efectivo.
            </p>
          </div>
        </Card>
      )}
      {history.error && <p role="alert">No se pudo cargar el historial.</p>}
      <Pagination meta={history.meta} pending={history.isFetching} onPage={setPage} />
      {action && (
        <CashForm
          action={action}
          expected={session?.expectedAmount}
          onClose={() => setAction(null)}
          onSaved={refresh}
        />
      )}
      <Card className="overflow-hidden">
        <div className="border-b p-5">
          <h2 className="font-display text-xl font-semibold">Historial de cajas</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Últimos turnos y diferencias de cuadre.
          </p>
        </div>
        {history.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="p-4 font-medium">Apertura</th>
                  <th className="p-4 font-medium">Estado</th>
                  <th className="p-4 text-right font-medium">Esperado</th>
                  <th className="p-4 text-right font-medium">Contado</th>
                  <th className="p-4 text-right font-medium">Diferencia</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.data.map((item) => (
                  <tr key={item.id}>
                    <td className="p-4">{new Date(item.openedAt).toLocaleString('es-GT')}</td>
                    <td className="p-4">{item.status === 'OPEN' ? 'Abierta' : 'Cerrada'}</td>
                    <td className="p-4 text-right">Q {item.expectedAmount}</td>
                    <td className="p-4 text-right">
                      {item.countedAmount ? `Q ${item.countedAmount}` : '—'}
                    </td>
                    <td
                      className={`p-4 text-right font-semibold ${Number(item.difference) < 0 ? 'text-danger' : Number(item.difference) > 0 ? 'text-warning' : ''}`}
                    >
                      {item.difference ? `Q ${item.difference}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Todavía no hay turnos registrados.
          </p>
        )}
      </Card>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-3 text-3xl font-bold">Q {value}</p>
    </Card>
  );
}
function CashForm({
  action,
  expected,
  onClose,
  onSaved,
}: {
  action: 'open' | 'movement' | 'close';
  expected?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const body =
        action === 'open'
          ? { openingFloat: Number(f.get('amount')), notes: f.get('notes') || undefined }
          : action === 'close'
            ? { countedAmount: Number(f.get('amount')), notes: f.get('notes') || undefined }
            : { type: f.get('type'), amount: Number(f.get('amount')), concept: f.get('concept') };
      await call(action, body);
      onSaved();
    } catch (x) {
      setError(x instanceof Error ? x.message : 'No pudimos completar la operación.');
    } finally {
      setBusy(false);
    }
  }
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Caja"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6">
        <h2 className="font-display text-2xl font-semibold">
          {action === 'open'
            ? 'Abrir caja'
            : action === 'close'
              ? 'Cerrar y cuadrar'
              : 'Registrar movimiento'}
        </h2>
        {action === 'close' && (
          <p className="rounded-xl bg-secondary p-3 text-sm">
            El sistema espera <strong>Q {expected}</strong>. Cuenta físicamente el efectivo antes de
            continuar.
          </p>
        )}
        {action === 'movement' && (
          <select name="type" className="h-11 w-full rounded-xl border bg-background px-3">
            <option value="CASH_IN">Entrada</option>
            <option value="CASH_OUT">Salida</option>
            <option value="EXPENSE">Gasto</option>
            <option value="WITHDRAWAL">Retiro</option>
          </select>
        )}
        <label className="block text-sm font-semibold">
          {action === 'close' ? 'Efectivo contado' : 'Monto'}
          <input
            required
            name="amount"
            type="number"
            min="0"
            step="0.01"
            className="mt-1 h-12 w-full rounded-xl border bg-background px-3"
          />
        </label>
        {action === 'movement' && (
          <label className="block text-sm font-semibold">
            Concepto
            <input
              required
              name="concept"
              className="mt-1 h-11 w-full rounded-xl border bg-background px-3"
            />
          </label>
        )}
        {action !== 'movement' && (
          <label className="block text-sm font-semibold">
            Notas
            <textarea name="notes" className="mt-1 w-full rounded-xl border bg-background p-3" />
          </label>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy}>{busy ? 'Procesando…' : 'Confirmar'}</Button>
        </div>
      </form>
    </div>
  );
}
