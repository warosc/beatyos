import type { Metadata } from 'next';
import { AppointmentLink } from '@/features/agenda/appointment-link';

export const metadata: Metadata = {
  title: 'Tu cita',
  // Un enlace personal no debe acabar en un buscador.
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AppointmentLink token={token} />;
}
