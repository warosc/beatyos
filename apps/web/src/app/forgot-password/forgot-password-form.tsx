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
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: string } | null;
      setError('root', { message: body?.detail ?? 'No pudimos procesar la solicitud.' });
      return;
    }
    reset();
    // El mismo mensaje exista o no la cuenta: distinguirlos revelaría quién trabaja aquí.
    setError('root', {
      type: 'success',
      message:
        'Listo. Si el correo está registrado, la propietaria verá tu solicitud y te dará una ' +
        'contraseña nueva.',
    });
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
        {isSubmitting ? 'Enviando…' : 'Pedir contraseña nueva'}
      </Button>
    </form>
  );
}
