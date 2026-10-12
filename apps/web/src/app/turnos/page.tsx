import type { Metadata } from 'next';
import { QueueBoard } from '@/features/queue/queue-board';

export const metadata: Metadata = { title: 'Turnos' };

export default function Page() {
  return <QueueBoard />;
}
