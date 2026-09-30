'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
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
  Sun,
  Trophy,
  Truck,
  Users,
} from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { LogoutButton } from '@/components/logout-button';
import { SessionContext } from '@/components/session-access';
import { fetchTenantProfile, TENANT_PROFILE_KEY } from '@/features/sales/types';
import { fetchPendingCount, PENDING_COUNT_KEY } from '@/features/service-tickets/types';
import { useIsStylist } from '@/features/stylist-day/my-stylist';
import { useMyDay } from '@/features/stylist-day/use-my-day';
import { applyBrand } from '@/lib/brand';
import { sessionFetch } from '@/lib/session-fetch';
import type { SessionUser } from '@/lib/auth';
const MY_DAY = '/mi-dia';
const nav = [
  ['Inicio', '/', LayoutDashboard, ['reports.read']],
  ['Mi día', MY_DAY, Sun, ['service-tickets.create.own']],
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
  // Aviso en «Caja» de los servicios que las estilistas han registrado y falta cobrar.
  const canSeeCharges =
    !!profile.data &&
    (profile.data.permissions.includes('*') ||
      profile.data.permissions.includes('service-tickets.read'));
  const pendingCharges = useQuery({
    queryKey: PENDING_COUNT_KEY,
    enabled: !isPublic && canSeeCharges,
    refetchInterval: 30_000,
    queryFn: fetchPendingCount,
  });
  // «Mi día» es de quien atiende clientas: exige la ficha de profesional además del permiso.
  const stylist = useIsStylist(isPublic ? [] : (profile.data?.permissions ?? []));
  const myDay = useMyDay(!isPublic && stylist.isStylist);
  const router = useRouter();
  const canSeeDashboard =
    !!profile.data &&
    (profile.data.permissions.includes('*') || profile.data.permissions.includes('reports.read'));
  // Quien no ve el panel de reportes no aterriza en una página vacía: la profesional va a su
  // día, que es donde trabaja.
  useEffect(() => {
    if (isPublic || pathname !== '/' || !profile.data || canSeeDashboard || stylist.pending) return;
    if (stylist.isStylist) router.replace(MY_DAY);
  }, [
    isPublic,
    pathname,
    profile.data,
    canSeeDashboard,
    stylist.pending,
    stylist.isStylist,
    router,
  ]);
  // Los colores son del salón de la sesión: se aplican al entrar y al cambiarlos.
  const salon = useQuery({
    queryKey: TENANT_PROFILE_KEY,
    enabled: !isPublic && !!profile.data,
    staleTime: 10 * 60_000,
    queryFn: fetchTenantProfile,
  });
  const brandTheme = salon.data?.brandTheme;
  useEffect(() => {
    if (brandTheme) applyBrand(brandTheme);
  }, [brandTheme]);
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
  const visible = nav.filter((x) => allowed(x[3]) && (x[1] !== MY_DAY || stylist.isStylist));
  const route = nav.find((x) =>
    x[1] === '/' ? pathname === '/' : pathname === x[1] || pathname.startsWith(x[1] + '/'),
  );
  const permitted = !route || allowed(route[3]);
  const badges: Partial<Record<string, number>> = {
    '/caja': pendingCharges.data ?? 0,
    // Citas que ya tocaban y la profesional aún no ha enviado a caja.
    [MY_DAY]: myDay.day.pendingCount,
  };
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
      <Badge count={badges[href]} />
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
              <span className="relative">
                <Icon size={20} />
                <Badge count={badges[href]} floating />
              </span>
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
function Badge({ count, floating = false }: { count?: number; floating?: boolean }) {
  if (!count) return null;
  return (
    <span
      aria-label={`${count} servicios por cobrar`}
      className={
        'grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold leading-5 text-primary-foreground ' +
        (floating ? 'absolute -top-2 -right-3' : 'ml-auto')
      }
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
