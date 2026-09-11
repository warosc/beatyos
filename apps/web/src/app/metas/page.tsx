import type { Metadata } from 'next';
import { GoalsBoard } from '@/features/goals/goals-board';
export const metadata: Metadata = { title: 'Metas' };
export default function Page() {
  return <GoalsBoard />;
}
