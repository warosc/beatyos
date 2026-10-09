'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  CalendarDays,
  ChartNoAxesCombined,
  CircleDollarSign,
  CircleHelp,
  LayoutDashboard,
  Menu,
  Package,
  Percent,
  Scissors,
  Settings,
  ShoppingBag,
  Sun,
  Trophy,
  Truck,
  UserRound,
  Users,
} from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useDialog } from '@/lib/use-dialog';
import { LogoutButton } from '@/components/logout-button';
import { SessionContext } from '@/components/session-access';
import { useAgendaLive } from '@/features/agenda/live';
import { usePendingChanges } from '@/features/agenda/use-agenda';
import { fetchTenantProfile, TENANT_PROFILE_KEY } from '@/features/sales/types';
import {
  fetchPasswordRequests,
  PASSWORD_REQUESTS_KEY,
} from '@/features/settings/password-requests';
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
  ['Clientas', '/clientes', Users, ['clients.read']],
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
/**
 * Lo que va en la barra inferior del teléfono, por orden de uso en el día. El resto queda
 * en «Más»: catorce iconos con desplazamiento lateral escondían Ayuda y Perfil sin avisar.
 */
const MOBILE_PRIORITY = [MY_DAY, '/', '/agenda', '/ventas', '/caja', '/clientes'];
const MOBILE_SLOTS = 4;
/** La sección está activa también en sus subpáginas: el historial es parte de Ventas. */
const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const isPublic =
    ['/login', '/forgot-password', '/reset-password', '/session'].includes(pathname) ||
    // El enlace del recordatorio lo abre la clienta, sin cuenta.
    pathname.startsWith('/cita/');
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
  // Aviso en «Equipo» de quien olvidó su contraseña y espera que la propietaria le asigne una.
  const canResetPasswords =
    !!profile.data &&
    (profile.data.permissions.includes('*') ||
      profile.data.permissions.includes('users.reset-password'));
  const passwordRequests = useQuery({
    queryKey: PASSWORD_REQUESTS_KEY,
    enabled: !isPublic && canResetPasswords,
    refetchInterval: 60_000,
    queryFn: fetchPasswordRequests,
    select: (requests) => requests.length,
  });
  // «Mi día» es de quien atiende clientas: exige la ficha de profesional además del permiso.
  const stylist = useIsStylist(isPublic ? [] : (profile.data?.permissions ?? []));
  const myDay = useMyDay(!isPublic && stylist.isStylist);
  // Aviso en «Agenda» de los cambios de hora que piden las profesionales.
  const has = (permission: string) =>
    !!profile.data &&
    (profile.data.permissions.includes('*') || profile.data.permissions.includes(permission));
  const canApproveChanges = has('appointments.approve-changes');
  const pendingChanges = usePendingChanges(!isPublic && canApproveChanges);
  // Un solo canal en vivo para toda la app: la agenda, «Mi día» y los avisos lo comparten.
  useAgendaLive({
    enabled: !isPublic && (has('appointments.read') || has('appointments.read.own')),
    approver: canApproveChanges,
    stylist: stylist.isStylist,
  });
  const router = useRouter();
  const canSeeDashboard =
    !!profile.data &&
    (profile.data.permissions.includes('*') || profile.data.permissions.includes('reports.read'));
  // Quien no ve el panel de reportes no aterriza en una página vacía: la profesional va a su
  // día, que es donde trabaja, y recepción a la agenda.
  const canSeeAgenda =
    !!profile.data &&
    ['*', 'appointments.read', 'appointments.read.own'].some((p) =>
      profile.data.permissions.includes(p),
    );
  useEffect(() => {
    if (isPublic || pathname !== '/' || !profile.data || canSeeDashboard || stylist.pending) return;
    if (stylist.isStylist) router.replace(MY_DAY);
    else if (canSeeAgenda) router.replace('/agenda');
  }, [
    canSeeAgenda,
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
        <Button variant="outline" className="my-3" onClick={() => profile.refetch()}>
          Reintentar
        </Button>
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
  const badges: Partial<Record<string, { count: number; label: string }>> = {
    '/caja': { count: pendingCharges.data ?? 0, label: 'servicios por cobrar' },
    // Citas que ya tocaban y la profesional aún no ha enviado a caja.
    [MY_DAY]: { count: myDay.day.pendingCount, label: 'citas por enviar a caja' },
    '/agenda': { count: pendingChanges.data ?? 0, label: 'cambios de cita por aprobar' },
    '/configuracion': {
      count: passwordRequests.data ?? 0,
      label: 'solicitudes de contraseña',
    },
  };
  const links = visible.map(([label, href, Icon]) => (
    <Link
      key={href}
      href={href}
      onClick={() => setMoreOpen(false)}
      aria-current={isActive(pathname, href) ? 'page' : undefined}
      className={
        'flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-muted ' +
        (isActive(pathname, href)
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground')
      }
    >
      <Icon size={19} className={isActive(pathname, href) ? 'text-primary' : undefined} />
      {label}
      <Badge {...badges[href]} />
    </Link>
  ));
  // Con pocas secciones caben todas; con más, las de uso diario y el resto en «Más».
  const ranked = [...visible].sort(
    (a, b) => (MOBILE_PRIORITY.indexOf(a[1]) + 1 || 99) - (MOBILE_PRIORITY.indexOf(b[1]) + 1 || 99),
  );
  const crowded = visible.length > MOBILE_SLOTS + 1;
  const primary = crowded ? ranked.slice(0, MOBILE_SLOTS) : visible;
  const secondary = crowded ? visible.filter((item) => !primary.includes(item)) : [];
  const moreBadge = secondary.reduce((sum, [, href]) => sum + (badges[href]?.count ?? 0), 0);
  const moreActive =
    secondary.some(([, href]) => isActive(pathname, href)) || onProfileRoute(pathname);
  const onProfile = pathname === '/perfil';
  return (
    <SessionContext.Provider value={user}>
      <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
        <aside className="hidden border-r bg-card px-4 py-6 lg:flex lg:flex-col">
          <Link
            href="/"
            className="mb-9 flex items-center gap-3 font-display text-xl font-semibold"
          >
            <Scissors className="text-primary" />
            BeautyOS
          </Link>
          <nav aria-label="Navegación principal" className="space-y-1">
            {links}
          </nav>
          <div className="mt-auto">
            <Link
              href="/perfil"
              aria-current={onProfile ? 'page' : undefined}
              className={
                'flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-muted ' +
                (onProfile ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground')
              }
            >
              <UserRound size={19} className={onProfile ? 'text-primary' : undefined} />
              Mi cuenta
            </Link>
            <LogoutButton />
          </div>
        </aside>
        <div className="min-w-0 pb-24 lg:pb-0">
          <header className="sticky top-0 z-20 flex min-h-17 items-center gap-3 border-b bg-background px-4">
            <span className="mr-auto min-w-0 truncate font-display text-xl">
              {salon.data?.name ?? 'BeautyOS'}
            </span>
            <ThemeToggle />
            <Link
              href="/perfil"
              aria-label="Abrir perfil"
              className="grid size-11 shrink-0 place-items-center rounded-full bg-secondary font-semibold text-secondary-foreground"
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
          {primary.map(([label, href, Icon]) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? 'page' : undefined}
              className={
                'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs ' +
                (isActive(pathname, href) ? 'text-primary' : 'text-muted-foreground')
              }
            >
              <span className="relative">
                <Icon size={20} />
                <Badge {...badges[href]} floating />
              </span>
              {label}
            </Link>
          ))}
          {crowded ? (
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className={
                'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs ' +
                (moreActive ? 'text-primary' : 'text-muted-foreground')
              }
            >
              <span className="relative">
                <Menu size={20} />
                <Badge count={moreBadge} label="avisos en otras secciones" floating />
              </span>
              Más
            </button>
          ) : (
            <Link
              href="/perfil"
              aria-current={onProfile ? 'page' : undefined}
              className={
                'flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs ' +
                (onProfile ? 'text-primary' : 'text-muted-foreground')
              }
            >
              <UserRound size={20} />
              Mi cuenta
            </Link>
          )}
        </nav>
        {moreOpen && (
          <MoreSheet onClose={() => setMoreOpen(false)}>
            {visible
              .filter((item) => secondary.includes(item))
              .map(([label, href, Icon]) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive(pathname, href) ? 'page' : undefined}
                  className={
                    'flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-muted ' +
                    (isActive(pathname, href)
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground')
                  }
                >
                  <Icon size={19} />
                  {label}
                  <Badge {...badges[href]} />
                </Link>
              ))}
            <Link
              href="/perfil"
              onClick={() => setMoreOpen(false)}
              className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              <UserRound size={19} />
              Mi cuenta
            </Link>
          </MoreSheet>
        )}
      </div>
    </SessionContext.Provider>
  );
}
const onProfileRoute = (pathname: string) => pathname === '/perfil';

/** Hoja inferior con las secciones que no caben en la barra del teléfono. */
function MoreSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useDialog(onClose);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Más secciones"
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="fixed inset-0 z-40 flex items-end bg-black/40 lg:hidden"
    >
      <nav
        aria-label="Más secciones"
        className="max-h-[80dvh] w-full space-y-1 overflow-y-auto rounded-t-3xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        {children}
      </nav>
    </div>
  );
}

function Badge({
  count,
  label,
  floating = false,
}: {
  count?: number;
  label?: string;
  floating?: boolean;
}) {
  if (!count) return null;
  return (
    <span
      aria-label={`${count} ${label}`}
      className={
        'grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold leading-5 text-primary-foreground ' +
        (floating ? 'absolute -top-2 -right-3' : 'ml-auto')
      }
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
