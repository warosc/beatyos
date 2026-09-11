import type { Metadata } from 'next';
import { PurchasesBoard } from '@/features/purchases/purchases-board';
export const metadata: Metadata = { title: 'Compras y proveedores' };
export default function Page() {
  return <PurchasesBoard />;
}
