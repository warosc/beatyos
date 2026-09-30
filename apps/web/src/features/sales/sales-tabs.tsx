'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccess } from '@/components/session-access';
import { cn } from '@/lib/utils';

/** Nueva venta | Ventas realizadas. La segunda solo con permiso para consultar ventas. */
export function SalesTabs() {
  const { can } = useAccess();
  const pathname = usePathname();
  if (!can('invoices.read')) return null;
  const tabs = [
    ['/ventas', 'Nueva venta'],
    ['/ventas/historial', 'Ventas realizadas'],
  ] as const;
  return (
    <nav aria-label="Ventas" className="flex gap-1 rounded-xl bg-muted p-1 sm:w-fit">
      {tabs.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? 'page' : undefined}
          className={cn(
            'flex h-9 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold whitespace-nowrap text-muted-foreground transition',
            pathname === href && 'bg-card text-foreground shadow-sm',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
