import type { Metadata } from 'next';
import { QueueStatsView } from '@/features/queue/queue-stats-view';

export const metadata: Metadata = { title: 'Estadísticas de la fila' };

export default function Page() {
  return <QueueStatsView />;
}
