'use client';
import { sessionFetch } from '@/lib/session-fetch';

import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { announceSessionChange } from '@/lib/session-fetch';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Ingresa tu contraseña actual.'),
    newPassword: z
      .string()
      .min(12, 'Usa al menos 12 caracteres.')
      .regex(/[a-z]/, 'Incluye una minúscula.')
      .regex(/[A-Z]/, 'Incluye una mayúscula.')
      .regex(/[0-9]/, 'Incluye un número.'),
    confirmation: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmation, {
    message: 'Las contraseñas no coinciden.',
    path: ['confirmation'],
  });
type Values = z.infer<typeof schema>;

export function ChangePasswordForm() {
  const cache = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmation: '' },
  });
  const submit = handleSubmit(async (values) => {
    const response = await sessionFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { message?: string };
      setError('root', { message: body.message ?? 'No pudimos cambiar la contraseña.' });
      return;
    }
    await cache.cancelQueries();
    cache.clear();
    announceSessionChange();
    location.replace('/login?passwordChanged=1');
  });
  const input =
    'mt-1.5 h-11 w-full rounded-xl border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15';
  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
        <KeyRound size={19} />
        Cambiar contraseña
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Se cerrarán todas tus sesiones por seguridad.
      </p>
      <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
        {(
          [
            ['currentPassword', 'Contraseña actual'],
            ['newPassword', 'Nueva contraseña'],
            ['confirmation', 'Confirmar contraseña'],
          ] as const
        ).map(([name, label]) => (
          <div key={name}>
            <label htmlFor={name} className="text-sm font-semibold">
              {label}
            </label>
            <input
              id={name}
              type="password"
              autoComplete={name === 'currentPassword' ? 'current-password' : 'new-password'}
              className={input}
              {...register(name)}
            />
            {errors[name] && <p className="mt-1 text-xs text-danger">{errors[name]?.message}</p>}
          </div>
        ))}
        {errors.root && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {errors.root.message}
          </p>
        )}
        <Button disabled={isSubmitting}>
          {isSubmitting && <LoaderCircle className="animate-spin" size={17} />}Actualizar contraseña
        </Button>
      </form>
    </Card>
  );
}
