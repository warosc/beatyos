import type { Metadata } from 'next';
import { QueueDisplayScreen } from '@/features/queue/queue-display';

export const metadata: Metadata = {
  title: 'Pantalla de turnos',
  // El enlace de la pantalla es una credencial: no debe acabar en un buscador.
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <QueueDisplayScreen token={token} />;
}
