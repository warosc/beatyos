'use client';
import { Can, useAccess } from '@/components/session-access';

import {
  AlertTriangle,
  ArrowLeft,
  Cake,
  CalendarPlus,
  Mail,
  MapPin,
  Pencil,
  Phone,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ClientForm } from './client-form';
import { FormulaGallery } from './formula-gallery';
import { ServiceHistory } from './service-history';
import type { Client } from './types';

export function ClientDetail({ client }: { client: Client }) {
  const { can } = useAccess();
  const canBookAppointment = can('appointments.create') || can('appointments.create.own');
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'services' | 'photos'>('services');
  const router = useRouter();
  return (
    <div className="space-y-6">
      <Link
        href="/clientes"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={18} />
        Clientes
      </Link>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <div className="grid size-16 place-items-center rounded-full bg-secondary font-display text-xl font-bold">
            {client.firstName[0]}
            {client.lastName[0]}
          </div>
          <div>
            <h1 className="font-display text-3xl font-semibold">{client.fullName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Clienta desde{' '}
              {new Intl.DateTimeFormat('es-GT', { month: 'long', year: 'numeric' }).format(
                new Date(client.createdAt),
              )}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Can permission="clients.update">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil size={17} />
              Editar
            </Button>
          </Can>
          {canBookAppointment && (
            <Button
              onClick={() => router.push('/agenda?new=1&client=' + encodeURIComponent(client.id))}
            >
              <CalendarPlus size={17} />
              Reservar cita
            </Button>
          )}
        </div>
      </div>
      {client.allergies && (
        <div className="flex gap-3 rounded-2xl border border-danger/25 bg-danger/8 p-4 text-sm">
          <AlertTriangle className="shrink-0 text-danger" size={20} />
          <div>
            <strong>Alergias y sensibilidades</strong>
            <p className="mt-1 text-muted-foreground">{client.allergies}</p>
          </div>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
        <Card className="p-6">
          <h2 className="font-display text-xl font-semibold">Información</h2>
          <div className="mt-5 space-y-4 text-sm">
            {client.phone && (
              <p className="flex items-center gap-3">
                <Phone className="text-muted-foreground" size={18} />
                {client.phone}
              </p>
            )}
            {client.email && (
              <p className="flex items-center gap-3">
                <Mail className="text-muted-foreground" size={18} />
                {client.email}
              </p>
            )}
            {client.city && (
              <p className="flex items-center gap-3">
                <MapPin className="text-muted-foreground" size={18} />
                {client.city}
              </p>
            )}
            {client.birthDate && (
              <p className="flex items-center gap-3">
                <Cake className="text-muted-foreground" size={18} />
                {new Intl.DateTimeFormat('es-GT', { day: 'numeric', month: 'long' }).format(
                  new Date(`${client.birthDate}T00:00:00`),
                )}
                {client.age !== null && ` · ${client.age} años`}
              </p>
            )}
          </div>
          {client.notes && (
            <div className="mt-6 border-t pt-5">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Notas
              </p>
              <p className="mt-2 text-sm leading-6">{client.notes}</p>
            </div>
          )}
        </Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">Gasto acumulado</p>
            <p className="mt-2 text-2xl font-bold">
              {client.totalSpent} {client.currency}
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">Visitas</p>
            <p className="mt-2 text-2xl font-bold">{client.totalVisits}</p>
          </Card>
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">Puntos</p>
            <p className="mt-2 text-2xl font-bold">{client.loyaltyPoints}</p>
          </Card>
        </div>
      </div>
      <Card className="p-6">
        <div className="flex rounded-xl bg-muted p-1 sm:w-fit">
          {(
            [
              ['services', 'Servicios'],
              ['photos', 'Fórmulas y fotos'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`min-h-10 rounded-lg px-4 text-sm font-semibold ${tab === key ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-5">
          {tab === 'services' ? (
            <ServiceHistory clientId={client.id} />
          ) : (
            <FormulaGallery clientId={client.id} />
          )}
        </div>
      </Card>
      {editing && (
        <ClientForm
          client={client}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
