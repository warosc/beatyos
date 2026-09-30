'use client';
import Link from 'next/link';
import { BellRing } from 'lucide-react';
import { useIsStylist } from './my-stylist';
import { useMyDay } from './use-my-day';

/** Recordatorio en la agenda: citas de hoy que ya tocaban y aún no se han enviado a caja. */
export function PendingRegisterBanner() {
  const { isStylist } = useIsStylist();
  const { day } = useMyDay(isStylist);
  if (!isStylist || day.pendingCount === 0) return null;
  return (
    <Link
      href="/mi-dia"
      className="flex items-center gap-2 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm hover:bg-warning/15"
    >
      <BellRing size={16} className="shrink-0 text-warning" />
      <span>
        {day.pendingCount === 1
          ? 'Tienes 1 clienta sin registrar.'
          : `Tienes ${day.pendingCount} clientas sin registrar.`}
      </span>
      <strong className="ml-auto text-primary">Ir a Mi día →</strong>
    </Link>
  );
}
