import type { Metadata } from 'next';
import { TeamAdministration } from '@/features/settings/team-administration';

export const metadata: Metadata = { title: 'Configuración' };
export default function Page() {
  return <TeamAdministration />;
}
