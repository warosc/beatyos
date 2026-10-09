import type { Metadata } from 'next';
import { SalonProfile } from '@/features/settings/salon-profile';
import { TeamAdministration } from '@/features/settings/team-administration';

export const metadata: Metadata = { title: 'Equipo y salón' };
export default function Page() {
  return (
    <div className="space-y-6">
      <TeamAdministration />
      <SalonProfile />
    </div>
  );
}
