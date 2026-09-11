'use client';
import { sessionFetch } from '@/lib/session-fetch';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Mail, MapPin, Phone, Plus, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Can } from '@/components/session-access';
import { Pagination } from '@/components/ui/pagination';
import type { ClientPage } from './types';
import { ClientForm } from './client-form';

export function ClientWorkspace({
  initial,
  unavailable,
}: {
  initial: ClientPage;
  unavailable: boolean;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const { data, isFetching, error } = useQuery({
    queryKey: ['clients', deferredSearch, page],
    queryFn: async ({ signal }) => {
      const response = await sessionFetch(
        `/api/clients?page=${page}&limit=20&sort=name:asc&search=${encodeURIComponent(deferredSearch)}`,
        { signal },
      );
      if (!response.ok) throw new Error();
      return response.json() as Promise<ClientPage>;
    },
    initialData: deferredSearch || page !== 1 || unavailable ? undefined : initial,
  });
  const clients = data?.data ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">CRM</p>
          <h1 className="mt-1 font-display text-3xl font-semibold sm:text-4xl">Clientes</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data?.meta.total ?? 0} fichas en tu salón
          </p>
        </div>
        <Can permission="clients.create">
          <Button onClick={() => setCreating(true)}>
            <Plus size={18} />
            Nueva clienta
          </Button>
        </Can>
      </div>
      <Card className="p-4 sm:p-5">
        <label className="flex h-12 items-center gap-3 rounded-xl border bg-background px-4">
          <Search size={19} className="text-muted-foreground" />
          <span className="sr-only">Buscar clientes</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre, correo o teléfono…"
            className="w-full bg-transparent text-sm outline-none"
          />
          {isFetching && (
            <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
        </label>
      </Card>
      {unavailable && clients.length === 0 ? (
        <Card className="flex items-center gap-3 border-warning/30 bg-warning/10 p-5 text-sm">
          <AlertCircle className="shrink-0 text-warning" />
          No fue posible conectar con la API. La pantalla se actualizará al reintentar la búsqueda.
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {clients.map((client) => (
          <Link
            href={`/clientes/${client.id}`}
            key={client.id}
            className="rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Card className="group h-full p-5 transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="flex items-start gap-4">
                <div className="grid size-12 shrink-0 place-items-center rounded-full bg-secondary font-display font-bold text-secondary-foreground">
                  {client.firstName[0]}
                  {client.lastName[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate font-semibold">{client.fullName}</h2>
                    <span className="rounded-full bg-success/10 px-2 py-1 text-[10px] font-bold text-success">
                      ACTIVA
                    </span>
                  </div>
                  <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                    {client.phone && (
                      <p className="flex items-center gap-2">
                        <Phone size={14} />
                        {client.phone}
                      </p>
                    )}
                    {client.email && (
                      <p className="flex items-center gap-2 truncate">
                        <Mail size={14} />
                        {client.email}
                      </p>
                    )}
                    {client.city && (
                      <p className="flex items-center gap-2">
                        <MapPin size={14} />
                        {client.city}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-3 border-t pt-4 text-center text-xs text-muted-foreground">
                <span>
                  <strong className="block text-base text-foreground">{client.totalVisits}</strong>
                  Visitas
                </span>
                <span className="border-x">
                  <strong className="block text-base text-foreground">
                    {client.loyaltyPoints}
                  </strong>
                  Puntos
                </span>
                <span>
                  <strong className="block text-base text-foreground">{client.totalSpent}</strong>
                  {client.currency}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
      {!isFetching && clients.length === 0 && !unavailable ? (
        <div className="grid min-h-64 place-items-center text-center">
          <div>
            <Users className="mx-auto text-muted-foreground" size={40} />
            <h2 className="mt-4 font-semibold">No encontramos clientas</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Prueba con otra búsqueda o crea una ficha nueva.
            </p>
          </div>
        </div>
      ) : null}
      {error && <p role="alert">No se pudieron cargar las fichas. Reintenta la búsqueda.</p>}
      <Pagination meta={data?.meta} pending={isFetching} onPage={setPage} />
      {creating && (
        <ClientForm
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: ['clients'] });
          }}
        />
      )}
    </div>
  );
}
