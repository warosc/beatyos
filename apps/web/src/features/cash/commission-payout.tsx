'use client';
import type { StylistCommission } from '@/features/sales/types';
import { money } from '@/lib/utils';

/**
 * Comisiones del turno por profesional (ADR-0026).
 *
 * Servicios y productos se muestran por separado porque son dos comisiones distintas, cada
 * una con su porcentaje; el total es lo que se le entrega al cerrar la caja. Es informativo:
 * no sale de la caja ni cambia el efectivo esperado.
 */

/** Unidades sin ceros de relleno: «3», «1.5». */
const units = (count: number) => String(Math.round(count * 1000) / 1000);

/** Tabla del resumen del turno, para revisar antes de cerrar. */
export function CommissionPayoutTable({
  commissions,
}: {
  commissions: readonly StylistCommission[] | undefined;
}) {
  return (
    <section aria-label="Comisiones del turno" className="border-t">
      <div className="p-5 pb-3">
        <h3 className="font-display text-lg font-semibold">Comisiones del turno</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Lo que ganó cada profesional con lo cobrado en este turno. Es informativo: no sale de la
          caja.
        </p>
      </div>
      {!commissions ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">Calculando…</p>
      ) : commissions.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">
          Ninguna venta del turno tiene profesional asignada.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-secondary/60 text-muted-foreground">
              <tr>
                <th className="p-3 text-left font-medium">Profesional</th>
                <th className="p-3 text-right font-medium">Servicios</th>
                <th className="p-3 text-right font-medium">Comisión</th>
                <th className="p-3 text-right font-medium">Productos</th>
                <th className="p-3 text-right font-medium">Comisión</th>
                <th className="p-3 text-right font-medium">Total a pagar</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {commissions.map((row) => (
                <tr key={row.stylistId}>
                  <td className="p-3 font-medium">{row.stylistName}</td>
                  <td className="p-3 text-right tabular-nums text-muted-foreground">
                    {units(row.services.count)} · {money(row.services.sold)}
                  </td>
                  <td className="p-3 text-right tabular-nums">{money(row.services.commission)}</td>
                  <td className="p-3 text-right tabular-nums text-muted-foreground">
                    {units(row.products.count)} · {money(row.products.sold)}
                  </td>
                  <td className="p-3 text-right tabular-nums">{money(row.products.commission)}</td>
                  <td className="p-3 text-right font-semibold tabular-nums">{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Lista corta del diálogo de cierre: lo que hay que entregarle a cada una. */
export function CommissionPayoutList({
  commissions,
}: {
  commissions: readonly StylistCommission[] | undefined;
}) {
  if (!commissions?.length) return null;
  return (
    <div aria-label="Comisiones a pagar" className="space-y-2 border-t pt-2">
      <p className="font-semibold">Comisiones a pagar</p>
      {commissions.map((row) => (
        <p key={row.stylistId} className="flex justify-between gap-3">
          <span>
            {row.stylistName}
            <span className="block text-xs text-muted-foreground">
              Servicios {money(row.services.commission)} · Productos{' '}
              {money(row.products.commission)}
            </span>
          </span>
          <strong className="tabular-nums">{money(row.total)}</strong>
        </p>
      ))}
      <p className="text-xs text-muted-foreground">No cambia el efectivo esperado.</p>
    </div>
  );
}

/** Sección del corte impreso de 80 mm. */
export function CommissionPayoutPrint({
  commissions,
}: {
  commissions: readonly StylistCommission[];
}) {
  return (
    <div className="mt-2 border-t border-dashed border-black pt-1">
      <p className="font-bold">COMISIONES A PAGAR</p>
      {commissions.length === 0 ? (
        <p>Ninguna venta con profesional.</p>
      ) : (
        commissions.map((row) => (
          <div key={row.stylistId} className="mt-1">
            <p className="font-bold">{row.stylistName}</p>
            <dl className="space-y-0.5">
              <PrintPair
                label={`Servicios (${units(row.services.count)}) de ${money(row.services.sold)}`}
                value={money(row.services.commission)}
              />
              <PrintPair
                label={`Productos (${units(row.products.count)}) de ${money(row.products.sold)}`}
                value={money(row.products.commission)}
              />
              <PrintPair label="Total a pagar" value={money(row.total)} strong />
            </dl>
          </div>
        ))
      )}
    </div>
  );
}

function PrintPair({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'font-bold' : ''}`}>
      <dt>{label}</dt>
      <dd className="text-right whitespace-nowrap">{value}</dd>
    </div>
  );
}
