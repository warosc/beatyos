import type { Metadata } from 'next';
import { InventoryBoard } from '@/features/inventory/inventory-board';
export const metadata: Metadata = { title: 'Inventario' };
export default function Page() {
  return <InventoryBoard />;
}
