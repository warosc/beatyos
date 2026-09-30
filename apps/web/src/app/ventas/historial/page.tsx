import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SalesHistory } from '@/features/sales/sales-history';

export const metadata: Metadata = { title: 'Ventas realizadas' };

export default function Page() {
  // `useSearchParams` necesita un límite de Suspense para no forzar el renderizado en cliente
  // de toda la ruta.
  return (
    <Suspense fallback={<p role="status">Cargando ventas…</p>}>
      <SalesHistory />
    </Suspense>
  );
}
