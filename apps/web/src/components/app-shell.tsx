'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  ChartNoAxesCombined,
  CircleDollarSign,
  CircleHelp,
  LayoutDashboard,
  Package,
  Percent,
  Scissors,
  Settings,
  ShoppingBag,
  Trophy,
  Truck,
  Users,
} from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { LogoutButton } from '@/components/logout-button';
import { SessionContext } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';
import type { SessionUser } from '@/lib/auth';
const nav = [
  ['Inicio', '/', LayoutDashboard, ['reports.read']],
  ['Agenda', '/agenda', CalendarDays, ['appointments.read', 'appointments.read.own']],
  ['Clientes', '/clientes', Users, ['clients.read']],
  ['Inventario', '/inventario', Package, ['products.read']],
  ['Compras', '/compras', Truck, ['purchases.read']],
  ['Ventas', '/ventas', ShoppingBag, ['invoices.create']],
  ['Caja', '/caja', CircleDollarSign, ['cash.read']],
  ['Reportes', '/reportes', ChartNoAxesCombined, ['reports.read']],
  ['Comisiones', '/comisiones', Percent, ['stylists.update', 'services.update']],
  ['Metas', '/metas', Trophy, ['goals.read', 'goals.read.own']],
  ['Equipo', '/configuracion', Settings, ['users.read', 'roles.read']],
  ['Ayuda', '/ayuda', CircleHelp, []],
] as const;
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = ['/login', '/forgot-password', '/reset-password', '/session'].includes(pathname);
  const profile = useQuery({
    queryKey: ['session-user'],
    enabled: !isPublic,
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      const r = await sessionFetch('/api/auth/me');
      if (!r.ok) throw new Error('No se pudo comprobar tu sesión.');
      const b = (await r.json()) as { data: SessionUser };
      return b.data;
    },
  });
  if (isPublic) return children;
  if (profile.isPending)
    return (
      <p role="status" className="p-8">
        Comprobando sesión…
      </p>
    );
  if (profile.isError || !profile.data)
    return (
      <div className="p-8">
        <p role="alert">No se pudo comprobar tu sesión.</p>
        <button onClick={() => profile.refetch()}>Reintentar</button>
        <LogoutButton />
      </div>
    );
  const user = profile.data;
  const allowed = (permissions: readonly string[]) =>
    permissions.length === 0 ||
    user.permissions.includes('*') ||
    permissions.some((p) => user.permissions.includes(p));
  const visible = nav.filter((x) => allowed(x[3]));
  const route = nav.find((x) =>
    x[1] === '/' ? pathname === '/' : pathname === x[1] || pathname.startsWith(x[1] + '/'),
  );
  const permitted = !route || allowed(route[3]);
  const links = visible.map(([label, href, Icon]) => (
    <Link
      key={href}
      href={href}
      aria-current={pathname === href ? 'page' : undefined}
      className={
        'flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-muted ' +
        (pathname === href ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground')
      }
    >
      <Icon size={19} />
      {label}
    </Link>
  ));
  return (
    <SessionContext.Provider value={user}>
      <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
        <aside className="hidden border-r bg-card px-4 py-6 lg:flex lg:flex-col">
          <Link
            href="/"
            className="mb-9 flex items-center gap-3 font-display text-xl font-semibold"
          >
            <Scissors />
            BeautyOS
          </Link>
          <nav aria-label="Navegación principal" className="space-y-1">
            {links}
          </nav>
          <div className="mt-auto">
            <Link href="/perfil" className="flex min-h-12 items-center px-3">
              Perfil y ajustes
            </Link>
            <LogoutButton />
          </div>
        </aside>
        <div className="min-w-0 pb-24 lg:pb-0">
          <header className="sticky top-0 z-20 flex min-h-17 items-center gap-3 border-b bg-background px-4">
            <span className="mr-auto font-display text-xl">BeautyOS</span>
            <ThemeToggle />
            <Link
              href="/perfil"
              aria-label="Abrir perfil"
              className="grid size-11 place-items-center rounded-full bg-secondary"
            >
              {user.firstName?.[0]}
              {user.lastName?.[0]}
            </Link>
          </header>
          <main className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8">
            {permitted ? (
              children
            ) : (
              <section>
                <h1 className="text-2xl font-semibold">
                  {pathname === '/' ? 'Tu espacio de trabajo' : 'Sin acceso a esta sección'}
                </h1>
                <p className="my-4">Selecciona una de tus secciones disponibles.</p>
                <div className="grid gap-2 sm:grid-cols-2">{links}</div>
              </section>
            )}
          </main>
        </div>
        <nav
          aria-label="Navegación móvil"
          className="fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          {visible.map(([label, href, Icon]) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? 'page' : undefined}
              className={
                'flex min-h-16 min-w-20 shrink-0 flex-col items-center justify-center gap-1 text-xs ' +
                (pathname === href ? 'text-primary' : 'text-muted-foreground')
              }
            >
              <Icon size={20} />
              {label}
            </Link>
          ))}
          <Link href="/perfil" className="flex min-w-20 items-center justify-center text-xs">
            Perfil
          </Link>
        </nav>
      </div>
    </SessionContext.Provider>
  );
}
