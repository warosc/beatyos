import type { Metadata } from 'next';
import { CashDesk } from '@/features/cash/cash-desk';
export const metadata: Metadata = { title: 'Caja' };
export default function Page() {
  return <CashDesk />;
}
