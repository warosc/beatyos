import type { Metadata } from 'next';
import { AgendaBoard } from '@/features/agenda/agenda-board';
export const metadata: Metadata = { title: 'Agenda' };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; client?: string }>;
}) {
  const query = await searchParams;
  return <AgendaBoard initialCreating={query.new === '1'} initialClientId={query.client} />;
}
