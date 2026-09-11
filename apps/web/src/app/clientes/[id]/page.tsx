import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Client } from '@/features/clients/types';
import { ClientDetail } from '@/features/clients/client-detail';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get('beautyos_access')?.value;
  const { id } = await params;
  if (!token) notFound();
  let client: Client | null = null;
  try {
    const response = await fetch(`${API_URL}/clients/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (response.status === 404) notFound();
    if (response.ok) {
      const body = (await response.json()) as { data: Client };
      client = body.data;
    }
  } catch {}
  if (!client)
    return (
      <div className="rounded-2xl border bg-card p-8 text-center">
        <h1 className="font-display text-2xl font-semibold">No pudimos cargar la ficha</h1>
        <p className="mt-2 text-sm text-muted-foreground">Comprueba la conexión con la API.</p>
      </div>
    );
  return <ClientDetail client={client} />;
}
