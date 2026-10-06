'use client';
import { BellRing, KeyRound } from 'lucide-react';
import { sessionFetch } from '@/lib/session-fetch';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export type PasswordRequest = {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  requestedAt: string;
};

export const PASSWORD_REQUESTS_KEY = ['password-reset-requests'] as const;

/** Avisos de «olvidé mi contraseña». Los consultan el menú (aviso en Equipo) y Equipo. */
export async function fetchPasswordRequests(): Promise<PasswordRequest[]> {
  const r = await sessionFetch('/api/admin?resource=password-reset-requests', {
    cache: 'no-store',
  });
  if (!r.ok) return [];
  const b = (await r.json()) as { data?: PasswordRequest[] };
  return b.data ?? [];
}

/** Bandeja de la propietaria: quién no puede entrar y está esperando una contraseña. */
export function PasswordRequests({
  requests,
  onAssign,
  onDismiss,
}: {
  requests: PasswordRequest[];
  onAssign: (request: PasswordRequest) => void;
  onDismiss: (request: PasswordRequest) => void;
}) {
  if (!requests.length) return null;
  return (
    <Card className="border-primary/40 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <BellRing size={18} className="text-primary" />
        {requests.length === 1
          ? '1 persona no puede entrar'
          : `${requests.length} personas no pueden entrar`}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pidieron una contraseña nueva desde «¿La olvidaste?». Asígnales una y compártela en persona.
      </p>
      <ul className="mt-4 divide-y">
        {requests.map((request) => (
          <li
            key={request.id}
            className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold">{request.fullName}</p>
              <p className="truncate text-sm text-muted-foreground">
                {request.email} · {new Date(request.requestedAt).toLocaleString('es-GT')}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => onAssign(request)}>
                <KeyRound size={16} />
                Asignar contraseña
              </Button>
              <Button variant="ghost" onClick={() => onDismiss(request)}>
                Descartar
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
