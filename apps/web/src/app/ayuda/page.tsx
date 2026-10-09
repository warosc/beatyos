import type { Metadata } from 'next';
import { HelpCenter } from '@/features/help/help-center';

export const metadata: Metadata = { title: 'Ayuda' };
export default function HelpPage() {
  return <HelpCenter />;
}
