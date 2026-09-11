'use client';
import { sessionFetch } from '@/lib/session-fetch';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
const schema = z
  .object({
    password: z
      .string()
      .min(12, 'Mínimo 12 caracteres.')
      .regex(/[A-ZÁÉÍÓÚÑÜ]/, 'Incluye una mayúscula.')
      .regex(/[a-záéíóúñü]/, 'Incluye una minúscula.')
      .regex(/\d/, 'Incluye un número.'),
    confirmation: z.string(),
  })
  .refine((v) => v.password === v.confirmation, {
    path: ['confirmation'],
    message: 'Las contraseñas no coinciden.',
  });
type Values = z.infer<typeof schema>;
export function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });
  const submit = handleSubmit(async (values) => {
    const response = await sessionFetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: values.password }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: string } | null;
      setError('root', { message: body?.detail ?? 'El enlace no es válido o venció.' });
      return;
    }
    setDone(true);
  });
  if (!token)
    return (
      <p role="alert" className="mt-6 rounded-xl bg-danger/10 p-4 text-sm text-danger">
        El enlace no contiene un token válido.
      </p>
    );
  if (done)
    return (
      <div className="mt-6 rounded-xl bg-secondary p-4 text-sm">
        Contraseña actualizada.{' '}
        <Link className="font-bold text-primary" href="/login">
          Iniciar sesión
        </Link>
      </div>
    );
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm font-semibold">
        Contraseña nueva
        <input
          {...register('password')}
          type="password"
          autoComplete="new-password"
          className="mt-2 h-12 w-full rounded-xl border bg-background px-4"
        />
      </label>
      {errors.password && <p className="text-sm text-danger">{errors.password.message}</p>}
      <label className="block text-sm font-semibold">
        Confirmar contraseña
        <input
          {...register('confirmation')}
          type="password"
          autoComplete="new-password"
          className="mt-2 h-12 w-full rounded-xl border bg-background px-4"
        />
      </label>
      {errors.confirmation && <p className="text-sm text-danger">{errors.confirmation.message}</p>}
      {errors.root && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {errors.root.message}
        </p>
      )}
      <Button className="w-full" disabled={!mounted || isSubmitting}>
        {isSubmitting ? 'Actualizando…' : 'Guardar contraseña'}
      </Button>
    </form>
  );
}
