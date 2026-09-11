'use client';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  CalendarClock,
  CircleCheck,
  Clock3,
  PackageMinus,
  Plus,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, currency } from '@/lib/utils';
import { DashboardReport, loadReport } from './types';

export function DashboardView() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const from = `${today.toISOString().slice(0, 10)}T00:00:00-06:00`;
  const to = `${tomorrow.toISOString().slice(0, 10)}T00:00:00-06:00`;
  const report = useQuery({
    queryKey: ['dashboard', from],
    queryFn: () =>
      loadReport<DashboardReport>(
        'dashboard',
        `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    refetchInterval: 60_000,
  });
  const data = report.data;
  const metrics = [
    {
      label: 'Ventas del día',
      value: currency.format(Number(data?.sales ?? 0)),
      detail: `${data?.tickets ?? 0} tickets cobrados`,
      icon: WalletCards,
      accent: 'text-success',
    },
    {
      label: 'Próximas citas',
      value: String(data?.upcoming.length ?? 0),
      detail: 'Siguientes reservas confirmadas',
      icon: CalendarClock,
      accent: 'text-primary',
    },
    {
      label: 'Productos bajos',
      value: String(data?.lowStockCount ?? 0),
      detail: 'En mínimo o agotados',
      icon: PackageMinus,
      accent: 'text-warning',
    },
  ];
  const top = data?.topStylists[0];
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-sm font-medium text-primary">
            {today.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Panel de operación
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Información actualizada desde Agenda, Ventas, Inventario y Caja.
          </p>
        </div>
        <Link href="/agenda?new=1" className={cn(buttonVariants(), 'w-full sm:w-auto')}>
          <Plus size={18} />
          Nueva cita
        </Link>
      </div>
      {report.isError && (
        <p role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {report.error.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, detail, icon: Icon, accent }) => (
          <Card className="p-5" key={label}>
            <div className="mb-5 flex items-start justify-between">
              <p className="text-sm font-medium text-muted-foreground">{label}</p>
              <span className="grid size-10 place-items-center rounded-xl bg-muted">
                <Icon className={accent} size={20} />
              </span>
            </div>
            <p className="text-3xl font-bold tracking-tight">{value}</p>
            <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
          </Card>
        ))}
        <Card className="overflow-hidden border-0 bg-primary p-5 text-primary-foreground">
          <div className="mb-5 flex items-start justify-between">
            <p className="text-sm font-medium opacity-75">Caja</p>
            <span className="flex items-center gap-2 rounded-full bg-white/12 px-3 py-1 text-xs font-semibold">
              <span
                className={`size-2 rounded-full ${data?.cash.isOpen ? 'bg-emerald-300' : 'bg-white/50'}`}
              />
              {data?.cash.isOpen ? 'Abierta' : 'Cerrada'}
            </span>
          </div>
          <p className="text-3xl font-bold tracking-tight">
            {currency.format(Number(data?.cash.expected ?? 0))}
          </p>
          <p className="mt-2 text-xs opacity-70">
            {data?.cash.openedAt
              ? `Desde ${new Date(data.cash.openedAt).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}`
              : 'Sin turno activo'}
          </p>
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-semibold">Próximas citas</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Las siguientes reservas del salón
              </p>
            </div>
            <Link
              href="/agenda"
              className="hidden items-center gap-1 text-sm font-semibold text-primary sm:flex"
            >
              Ver agenda <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="divide-y">
            {data?.upcoming.length ? (
              data.upcoming.map((item) => (
                <article
                  key={item.id}
                  className="grid grid-cols-[64px_1fr_auto] items-center gap-3 py-4 first:pt-0 last:pb-0"
                >
                  <div>
                    <p className="text-sm font-bold">
                      {new Date(item.startsAt).toLocaleTimeString('es-GT', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(item.startsAt).toLocaleDateString('es-GT', {
                        day: '2-digit',
                        month: 'short',
                      })}
                    </p>
                  </div>
                  <div
                    className="min-w-0 border-l-2 pl-3"
                    style={{ borderColor: item.stylistColor }}
                  >
                    <p className="truncate text-sm font-semibold">{item.client}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.service} · {item.stylist}
                    </p>
                  </div>
                  <span className="hidden rounded-full bg-secondary px-3 py-1 text-xs font-medium sm:inline">
                    {item.status === 'CONFIRMED' ? 'Confirmada' : 'Programada'}
                  </span>
                </article>
              ))
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No hay próximas citas.
              </p>
            )}
          </div>
        </Card>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-1">
          <Card className="relative overflow-hidden p-5 sm:p-6">
            <Sparkles className="absolute -right-4 -top-4 size-24 text-secondary" />
            <p className="text-sm font-medium text-muted-foreground">Estilista destacada</p>
            <div className="mt-5">
              <h2 className="font-display text-xl font-semibold">
                {top?.name ?? 'Sin ventas asignadas'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {currency.format(Number(top?.revenue ?? 0))} en ventas hoy
              </p>
            </div>
            <div className="mt-5 flex gap-6 border-t pt-4 text-sm">
              <span>
                <strong>{top?.services ?? 0}</strong> servicios
              </span>
              <span className="flex items-center gap-1 text-success">
                <CircleCheck size={15} />
                Datos reales
              </span>
            </div>
          </Card>
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Ocupación de hoy</p>
                <p className="mt-2 text-3xl font-bold">{data?.occupancyRate ?? 0}%</p>
              </div>
              <div className="grid size-14 place-items-center rounded-full border-4 border-primary text-xs font-bold">
                {data?.occupancyRate ?? 0}
              </div>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${data?.occupancyRate ?? 0}%` }}
              />
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 size={14} />
              {data?.completedAppointments ?? 0} citas completadas
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
