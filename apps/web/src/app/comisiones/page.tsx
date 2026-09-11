import type { Metadata } from 'next';
import { Commissions } from '@/features/settings/commissions';
export const metadata: Metadata = { title: 'Comisiones' };
export default function Page() {
  return <Commissions />;
}
