'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { announceSessionChange, sessionFetch } from '@/lib/session-fetch';
import { useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';

const schema = z.object({
  email: z.string().email('Ingresa un correo válido.'),
  password: z.string().min(1, 'Ingresa tu contraseña.').max(128),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const cache = useQueryClient();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [visible, setVisible] = useState(false);
  const [serverError, setServerError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const submit = handleSubmit(async (values) => {
    setServerError('');
    const response = await sessionFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!response.ok) {
      const body = (await response.json()) as { message?: string };
      setServerError(body.message ?? 'No pudimos iniciar sesión.');
      return;
    }
    await cache.cancelQueries();
    cache.clear();
    announceSessionChange();
    window.location.replace('/');
  });
  const field =
    'mt-2 h-12 w-full rounded-xl border bg-card px-4 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/15';
  return (
    <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
      <div>
        <label htmlFor="email" className="text-sm font-semibold">
          Correo electrónico
        </label>
        <input
          disabled={!mounted}
          id="email"
          type="email"
          autoComplete="email"
          placeholder="tu@salon.com"
          aria-invalid={!!errors.email}
          className={field}
          {...register('email')}
        />
        {errors.email && <p className="mt-1.5 text-xs text-danger">{errors.email.message}</p>}
      </div>
      <div>
        <div className="flex justify-between">
          <label htmlFor="password" className="text-sm font-semibold">
            Contraseña
          </label>
          <Link
            href="/forgot-password"
            className="text-sm font-semibold text-primary hover:underline"
          >
            ¿La olvidaste?
          </Link>
        </div>
        <div className="relative">
          <input
            disabled={!mounted}
            id="password"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            aria-invalid={!!errors.password}
            className={`${field} pr-12`}
            {...register('password')}
          />
          <button
            type="button"
            onClick={() => setVisible((value) => !value)}
            className="absolute right-1 top-3 grid size-10 place-items-center text-muted-foreground"
            aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            {visible ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        {errors.password && <p className="mt-1.5 text-xs text-danger">{errors.password.message}</p>}
      </div>
      {serverError && (
        <div role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
          {serverError}
        </div>
      )}
      <Button className="w-full" disabled={!mounted || isSubmitting}>
        {isSubmitting && <LoaderCircle className="animate-spin" size={18} />}
        {isSubmitting ? 'Ingresando…' : 'Ingresar'}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Al continuar aceptas las políticas de seguridad de tu organización.
      </p>
    </form>
  );
}
