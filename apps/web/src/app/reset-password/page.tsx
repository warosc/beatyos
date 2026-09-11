import { Suspense } from 'react';
import { ResetPasswordForm } from './reset-password-form';
export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">
        <h1 className="font-display text-3xl font-semibold">Nueva contraseña</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Usa 12 caracteres o más, con mayúscula, minúscula y número.
        </p>
        <Suspense fallback={<p className="mt-6">Cargando…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </section>
    </main>
  );
}
