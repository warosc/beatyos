import type { Metadata } from 'next';
import { Scissors, ShieldCheck, Sparkles } from 'lucide-react';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Iniciar sesión' };

export default function LoginPage() {
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
      <section className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col">
        <div className="absolute -left-32 -top-32 size-96 rounded-full bg-white/8" />
        <div className="absolute -bottom-48 -right-24 size-[32rem] rounded-full border border-white/10" />
        <div className="relative flex items-center gap-3 font-display text-2xl font-semibold">
          <span className="grid size-11 place-items-center rounded-xl bg-white/12">
            <Scissors size={21} />
          </span>
          BeautyOS
        </div>
        <div className="relative my-auto max-w-xl">
          <Sparkles className="mb-8 opacity-70" />
          <h1 className="font-display text-5xl font-semibold leading-tight">
            La belleza de gestionar todo con calma.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 opacity-75">
            Agenda, clientes, inventario y caja en un solo lugar diseñado para que tu equipo haga su
            mejor trabajo.
          </p>
        </div>
        <p className="relative flex items-center gap-2 text-sm opacity-70">
          <ShieldCheck size={17} />
          Acceso seguro y protegido
        </p>
      </section>
      <section className="flex items-center justify-center bg-background p-6 sm:p-12">
        <div className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 font-display text-2xl font-semibold lg:hidden">
            <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Scissors size={21} />
            </span>
            BeautyOS
          </div>
          <p className="text-sm font-semibold text-primary">Te damos la bienvenida</p>
          <h2 className="mt-2 font-display text-4xl font-semibold tracking-tight">Inicia sesión</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Ingresa tus datos para acceder a tu salón.
          </p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
