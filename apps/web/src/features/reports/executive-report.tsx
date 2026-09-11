'use client';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarRange,
  ChartNoAxesCombined,
  CircleDollarSign,
  Percent,
  Receipt,
  RefreshCw,
  UsersRound,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { currency } from '@/lib/utils';
import { ExecutiveReport, loadReport } from './types';

const iso = (date: Date) => date.toISOString().slice(0, 10);
export function ExecutiveReportView() {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getTime() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(now));
  const report = useQuery({
    queryKey: ['reports', from, to],
    queryFn: () =>
      loadReport<ExecutiveReport>(
        'executive',
        `&from=${from}T00:00:00-06:00&to=${to}T23:59:59-06:00`,
      ),
  });
  const data = report.data;
  const maxSale = Math.max(1, ...(data?.dailySales.map((item) => Number(item.total)) ?? []));
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Inteligencia del negocio</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Reportes ejecutivos</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Ventas, retención, productividad y ocupación en quetzales.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <DateField label="Desde" value={from} onChange={setFrom} />
          <DateField label="Hasta" value={to} onChange={setTo} />
          <Button variant="outline" onClick={() => report.refetch()}>
            <RefreshCw size={16} />
            Actualizar
          </Button>
        </div>
      </div>
      {report.isError && (
        <p role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {report.error.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          icon={CircleDollarSign}
          label="Ventas"
          value={currency.format(Number(data?.sales ?? 0))}
        />
        <Metric
          icon={Receipt}
          label="Ticket promedio"
          value={currency.format(Number(data?.averageTicket ?? 0))}
        />
        <Metric icon={UsersRound} label="Retención" value={`${data?.retentionRate ?? 0}%`} />
        <Metric icon={CalendarRange} label="Ocupación" value={`${data?.occupancyRate ?? 0}%`} />
        <Metric
          icon={Percent}
          label="Comisiones"
          value={currency.format(Number(data?.commissionTotal ?? 0))}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card className="p-5">
          <h2 className="font-display text-xl font-semibold">Tendencia de ventas</h2>
          <div className="mt-6 flex min-h-64 items-end gap-2 overflow-x-auto">
            {data?.dailySales.length ? (
              data.dailySales.map((item) => (
                <div key={item.date} className="flex min-w-12 flex-1 flex-col items-center gap-2">
                  <span className="text-[10px] font-semibold">
                    Q {Number(item.total).toFixed(0)}
                  </span>
                  <div
                    className="w-full rounded-t-lg bg-primary"
                    style={{ height: `${Math.max(5, (Number(item.total) / maxSale) * 180)}px` }}
                  />
                  <span className="text-[10px] text-muted-foreground">{item.date.slice(5)}</span>
                </div>
              ))
            ) : (
              <Empty />
            )}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="font-display text-xl font-semibold">Resumen de citas</h2>
          <div className="mt-6 space-y-4">
            <Summary label="Completadas" value={data?.completedAppointments ?? 0} />
            <Summary label="Canceladas" value={data?.cancelledAppointments ?? 0} />
            <Summary label="Tickets cobrados" value={data?.tickets ?? 0} />
          </div>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Ranking
          title="Productos más vendidos"
          rows={(data?.topProducts ?? []).map((x) => ({
            name: x.name,
            detail: `${x.quantity} unidades`,
            value: currency.format(Number(x.revenue)),
          }))}
        />
        <Ranking
          title="Estilistas más rentables"
          rows={(data?.topStylists ?? []).map((x) => ({
            name: x.name,
            detail: `${x.services} servicios · Comisión ${currency.format(Number(x.commission))}`,
            value: currency.format(Number(x.revenue)),
          }))}
        />
      </div>
    </div>
  );
}
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-semibold text-muted-foreground">
      {label}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block h-11 rounded-xl border bg-card px-3 text-sm text-foreground"
      />
    </label>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ChartNoAxesCombined;
  label: string;
  value: string;
}) {
  return (
    <Card className="p-5">
      <span className="grid size-10 place-items-center rounded-xl bg-secondary text-primary">
        <Icon size={20} />
      </span>
      <p className="mt-5 text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </Card>
  );
}
function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between rounded-xl bg-muted p-4">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Ranking({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; detail: string; value: string }[];
}) {
  return (
    <Card className="overflow-hidden">
      <h2 className="border-b p-5 font-display text-xl font-semibold">{title}</h2>
      {rows.length ? (
        <div className="divide-y">
          {rows.map((row, index) => (
            <div
              key={`${row.name}-${index}`}
              className="grid grid-cols-[32px_1fr_auto] items-center gap-3 p-4"
            >
              <span className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-bold">
                {index + 1}
              </span>
              <div>
                <p className="font-semibold">{row.name}</p>
                <p className="text-xs text-muted-foreground">{row.detail}</p>
              </div>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-8">
          <Empty />
        </div>
      )}
    </Card>
  );
}
function Empty() {
  return <p className="m-auto text-sm text-muted-foreground">No hay datos en este período.</p>;
}
