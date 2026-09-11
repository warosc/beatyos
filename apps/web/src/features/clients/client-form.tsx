'use client';
import { useDialog } from '@/lib/use-dialog';
import { sessionFetch } from '@/lib/session-fetch';

import { zodResolver } from '@hookform/resolvers/zod';
import { LoaderCircle, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import type { Client } from './types';

const schema = z
  .object({
    firstName: z.string().trim().min(1, 'El nombre es obligatorio.').max(100),
    lastName: z.string().trim().min(1, 'El apellido es obligatorio.').max(100),
    email: z.string().trim().email('Correo no válido.').or(z.literal('')),
    phone: z.string().trim().max(20),
    birthDate: z.string().trim(),
    city: z.string().trim().max(100),
    allergies: z.string().trim().max(1000),
    notes: z.string().trim().max(2000),
    marketingConsent: z.boolean(),
  })
  .refine((value) => value.email || value.phone, {
    message: 'Ingresa al menos un correo o teléfono.',
    path: ['phone'],
  });
type Values = z.infer<typeof schema>;

export function ClientForm({
  client,
  onClose,
  onSaved,
}: {
  client?: Client;
  onClose: () => void;
  onSaved: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: client?.firstName ?? '',
      lastName: client?.lastName ?? '',
      email: client?.email ?? '',
      phone: client?.phone ?? '',
      birthDate: client?.birthDate ?? '',
      city: client?.city ?? '',
      allergies: client?.allergies ?? '',
      notes: client?.notes ?? '',
      marketingConsent: client?.marketingConsent ?? false,
    },
  });
  const submit = handleSubmit(async (values) => {
    const payload = {
      ...values,
      email: values.email || null,
      phone: values.phone || null,
      birthDate: values.birthDate || null,
      city: values.city || null,
      allergies: values.allergies || null,
      notes: values.notes || null,
    };
    const response = await sessionFetch(client ? `/api/clients/${client.id}` : '/api/clients', {
      method: client ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = (await response.json()) as { detail?: string; title?: string };
      setError('root', { message: body.detail ?? body.title ?? 'No pudimos guardar la ficha.' });
      return;
    }
    onSaved();
  });
  const input =
    'mt-1.5 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 p-0 sm:place-items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-form-title"
    >
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-card p-6 shadow-2xl sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-primary">CRM</p>
            <h2 id="client-form-title" className="font-display text-2xl font-semibold">
              {client ? 'Editar clienta' : 'Nueva clienta'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="grid size-11 place-items-center rounded-xl hover:bg-muted"
          >
            <X />
          </button>
        </div>
        <form onSubmit={submit} className="mt-6 grid gap-4 sm:grid-cols-2" noValidate>
          {(
            [
              ['firstName', 'Nombre'],
              ['lastName', 'Apellido'],
              ['email', 'Correo electrónico'],
              ['phone', 'Teléfono'],
              ['city', 'Ciudad'],
            ] as const
          ).map(([name, label]) => (
            <div key={name}>
              <label htmlFor={name} className="text-sm font-semibold">
                {label}
              </label>
              <input id={name} className={input} {...register(name)} />
              {errors[name] && <p className="mt-1 text-xs text-danger">{errors[name]?.message}</p>}
            </div>
          ))}
          <div>
            <label htmlFor="birthDate" className="text-sm font-semibold">
              Fecha de nacimiento
            </label>
            <input id="birthDate" type="date" className={input} {...register('birthDate')} />
            {errors.birthDate && (
              <p className="mt-1 text-xs text-danger">{errors.birthDate.message}</p>
            )}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="allergies" className="text-sm font-semibold">
              Alergias y sensibilidades
            </label>
            <textarea
              id="allergies"
              rows={2}
              className={`${input} h-auto py-3`}
              {...register('allergies')}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="notes" className="text-sm font-semibold">
              Notas
            </label>
            <textarea
              id="notes"
              rows={3}
              className={`${input} h-auto py-3`}
              {...register('notes')}
            />
          </div>
          <label className="flex items-center gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="size-5 accent-[var(--primary)]"
              {...register('marketingConsent')}
            />
            Acepta comunicaciones de marketing
          </label>
          {errors.root && (
            <p
              role="alert"
              className="rounded-xl bg-danger/10 p-3 text-sm text-danger sm:col-span-2"
            >
              {errors.root.message}
            </p>
          )}
          <div className="flex justify-end gap-3 border-t pt-5 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={isSubmitting}>
              {isSubmitting && <LoaderCircle className="animate-spin" size={17} />}Guardar ficha
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
