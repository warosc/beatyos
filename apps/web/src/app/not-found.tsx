import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="grid min-h-[65vh] place-items-center text-center">
      <div>
        <p className="font-display text-7xl font-semibold text-primary">404</p>
        <h1 className="mt-3 text-2xl font-bold">Esta sección aún no está disponible</h1>
        <p className="mt-2 text-muted-foreground">Estamos construyendo esta experiencia.</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
