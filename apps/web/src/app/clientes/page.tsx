import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ClientWorkspace } from '@/features/clients/client-workspace';
import type { ClientPage } from '@/features/clients/types';

export const metadata: Metadata = { title: 'Clientes' };
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export default async function ClientsPage() {
  const token = (await cookies()).get('beautyos_access')?.value;
  let initial: ClientPage = {
    data: [],
    meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false },
  };
  let unavailable = false;
  if (token) {
    try {
      const response = await fetch(`${API_URL}/clients?limit=20&sort=name:asc`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (response.ok) initial = (await response.json()) as ClientPage;
      else unavailable = true;
    } catch {
      unavailable = true;
    }
  }
  return <ClientWorkspace initial={initial} unavailable={unavailable} />;
}
