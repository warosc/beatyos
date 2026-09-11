import type { Metadata } from 'next';
import { Pos } from '@/features/sales/pos';
export const metadata: Metadata = { title: 'Ventas' };
export default function Page() {
  return <Pos />;
}
