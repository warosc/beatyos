'use client';
import { sessionFetch } from '@/lib/session-fetch';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
const schema = z.object({ email: z.string().email('Ingresa un correo válido.') });
type Values = z.infer<typeof schema>;
export function ForgotPasswordForm() {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<Values>({ resolver: zodResolver(schema) });
  const submit = handleSubmit(async (values) => {
    const response = await sessionFetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: { message?: string; resetPath?: string };
      detail?: string;
    } | null;
    if (!response.ok) {
      setError('root', { message: body?.detail ?? 'No pudimos procesar la solicitud.' });
      return;
    }
    reset();
    setError('root', { type: 'success', message: body?.data?.message ?? 'Revisa tu correo.' });
    if (body?.data?.resetPath)
      window.setTimeout(() => {
        window.location.href = body.data!.resetPath!;
      }, 900);
  });
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm font-semibold">
        Correo electrónico
        <input
          {...register('email')}
          type="email"
          autoComplete="email"
          className="mt-2 h-12 w-full rounded-xl border bg-background px-4"
        />
      </label>
      {errors.email && <p className="text-sm text-danger">{errors.email.message}</p>}
      {errors.root && (
        <p
          role="status"
          className={`rounded-xl p-3 text-sm ${errors.root.type === 'success' ? 'bg-secondary text-foreground' : 'bg-danger/10 text-danger'}`}
        >
          {errors.root.message}
        </p>
      )}
      <Button className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Enviando…' : 'Enviar instrucciones'}
      </Button>
    </form>
  );
}
