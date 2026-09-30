'use client';
import { cn } from '@/lib/utils';

export type PosStylist = {
  id: string;
  displayName: string;
  color?: string | null;
  skills?: { serviceId: string }[];
};

/** Sin habilidades registradas, la profesional hace de todo (así lo entiende la API). */
export const canPerform = (stylist: PosStylist, serviceId: string) =>
  !stylist.skills?.length || stylist.skills.some((skill) => skill.serviceId === serviceId);

/**
 * Selector de la profesional que hizo el trabajo: es quien cobra la comisión.
 *
 * Para un servicio, primero las que saben hacerlo. Las demás siguen disponibles —una
 * habilidad sin registrar no debe impedir cobrar—, pero en un grupo aparte.
 */
export function StylistSelect({
  stylists,
  value,
  onChange,
  serviceId,
  label,
  className,
}: {
  stylists: readonly PosStylist[];
  value: string | null;
  onChange: (stylistId: string | null) => void;
  serviceId?: string;
  label: string;
  className?: string;
}) {
  const able = serviceId ? stylists.filter((s) => canPerform(s, serviceId)) : stylists;
  const others = serviceId ? stylists.filter((s) => !canPerform(s, serviceId)) : [];
  const option = (stylist: PosStylist) => (
    <option key={stylist.id} value={stylist.id}>
      {stylist.displayName}
    </option>
  );

  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className={cn(
        'h-10 min-w-0 rounded-lg border bg-background px-2 text-sm',
        !value && 'text-muted-foreground',
        className,
      )}
    >
      <option value="">Sin estilista</option>
      {others.length ? (
        <>
          <optgroup label="Hacen este servicio">{able.map(option)}</optgroup>
          <optgroup label="Otras">{others.map(option)}</optgroup>
        </>
      ) : (
        able.map(option)
      )}
    </select>
  );
}
