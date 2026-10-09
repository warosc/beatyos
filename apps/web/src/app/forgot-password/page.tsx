import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Mail } from 'lucide-react';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Recuperar contraseña' };

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
          <Mail />
        </span>
        <h1 className="mt-6 text-center font-display text-3xl font-semibold">Recuperar acceso</h1>
        <p className="mt-3 text-center text-sm leading-6 text-muted-foreground">
          Escribe el correo de tu cuenta. Avisaremos a la propietaria del salón para que te asigne
          una contraseña nueva.
        </p>
        <ForgotPasswordForm />
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          ¿Eres la propietaria? Pide ayuda al soporte de BeautyOS.
        </p>
        <Link
          href="/login"
          className="mt-5 flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-primary hover:bg-muted"
        >
          <ArrowLeft size={17} />
          Volver al inicio de sesión
        </Link>
      </section>
    </main>
  );
}
