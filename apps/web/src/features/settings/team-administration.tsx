'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Search, ShieldCheck, UserRoundCog, UsersRound, X } from 'lucide-react';
import { usePagedList } from '@/lib/use-paged-list';
import { Pagination } from '@/components/ui/pagination';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Role = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
};
type Permission = { code: string; resource: string; action: string; description: string };
type User = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: Array<{ id: string; code: string }>;
  deletedAt: string | null;
};
type Problem = { detail?: string; message?: string; errors?: Array<{ message: string }> };
type Notice = { kind: 'success' | 'error'; text: string };

const userSchema = z.object({
  firstName: z.string().trim().min(2, 'Ingresa el nombre.'),
  lastName: z.string().trim().min(2, 'Ingresa el apellido.'),
  email: z.string().email('Ingresa un correo válido.'),
  phone: z.string().optional(),
  password: z
    .string()
    .min(12, 'Usa al menos 12 caracteres.')
    .regex(/[A-ZÁÉÍÓÚÑÜ]/, 'Incluye una mayúscula.')
    .regex(/[a-záéíóúñü]/, 'Incluye una minúscula.')
    .regex(/\d/, 'Incluye un número.'),
  roleIds: z.array(z.string()).min(1, 'Selecciona al menos un rol.'),
});
const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{1,39}$/, 'Código inválido.'),
  name: z.string().trim().min(2, 'Ingresa un nombre.'),
  description: z.string().max(300).optional(),
  permissionCodes: z.array(z.string()).min(1, 'Selecciona al menos un permiso.'),
});
type UserValues = z.infer<typeof userSchema>;
type RoleValues = z.infer<typeof roleSchema>;
const problemText = (body: Problem) =>
  body.errors?.map((x) => x.message).join(' · ') ??
  body.detail ??
  body.message ??
  'No pudimos completar la operación.';
async function get<T>(resource: string) {
  const response = await sessionFetch(`/api/admin?resource=${resource}`, { cache: 'no-store' });
  const body = (await response.json()) as { data?: T } & Problem;
  if (!response.ok) throw new Error(problemText(body));
  return (body.data ?? body) as T;
}

export function TeamAdministration() {
  const cache = useQueryClient();
  const { can } = useAccess();
  const [page, setPage] = useState(1);
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [tab, setTab] = useState<'users' | 'roles'>(can('users.read') ? 'users' : 'roles');
  const [dialog, setDialog] = useState<'user' | 'role' | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const users = usePagedList<User>(
    'admin-users',
    '/api/admin?resource=users&limit=20&page=' + page + '&search=' + encodeURIComponent(search),
    can('users.read'),
  );
  const roles = useQuery({
    queryKey: ['admin-roles'],
    enabled: can('roles.read'),
    queryFn: () => get<Role[]>('roles'),
  });
  const permissions = useQuery({
    queryKey: ['admin-permissions'],
    enabled: can('roles.read'),
    queryFn: () => get<Permission[]>('permissions'),
  });
  const visible = useMemo(
    () =>
      users.data?.filter((user) =>
        `${user.fullName} ${user.email}`.toLowerCase().includes(search.toLowerCase()),
      ) ?? [],
    [users.data, search],
  );
  const refresh = async () => {
    setDialog(null);
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['admin-users'] }),
      cache.invalidateQueries({ queryKey: ['admin-roles'] }),
    ]);
  };
  async function mutate(url: string, method: 'PATCH' | 'PUT' | 'DELETE' | 'POST', body?: unknown) {
    if (method === 'DELETE' && !window.confirm('¿Eliminar este rol?')) return;
    setNotice(null);
    const response = await sessionFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: problemText((await response.json()) as Problem) });
      return;
    }
    setNotice({ kind: 'success', text: 'Cambios guardados correctamente.' });
    await refresh();
  }
  const error = users.error ?? roles.error ?? permissions.error;
  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-semibold text-primary">Administración</p>
          <h1 className="font-display text-4xl font-semibold">Equipo y permisos</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Controla quién entra a BeautyOS y qué puede hacer.
          </p>
        </div>
        <Button
          disabled={!mounted || !can(tab === 'users' ? 'users.create' : 'roles.create')}
          onClick={() => setDialog(tab === 'users' ? 'user' : 'role')}
        >
          <Plus size={17} />
          {tab === 'users' ? 'Nuevo usuario' : 'Nuevo rol'}
        </Button>
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={UsersRound} label="Usuarios" value={users.data?.length ?? 0} />
        <Stat icon={ShieldCheck} label="Roles" value={roles.data?.length ?? 0} />
        <Stat icon={KeyRound} label="Permisos" value={permissions.data?.length ?? 0} />
      </div>
      {notice && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-xl p-3 text-sm ${notice.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-secondary'}`}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {error.message}
        </p>
      )}
      <div className="flex rounded-xl bg-muted p-1 sm:w-fit">
        {(
          [
            ['users', 'Usuarios'],
            ['roles', 'Roles'],
          ] as const
        )
          .filter(([key]) => can(key === 'users' ? 'users.read' : 'roles.read'))
          .map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`min-h-11 rounded-lg px-6 text-sm font-semibold ${tab === key ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
      </div>
      {tab === 'users' ? (
        <>
          <label className="flex h-12 items-center gap-2 rounded-xl border bg-card px-4">
            <Search size={18} />
            <input
              aria-label="Buscar usuarios"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Buscar por nombre o correo…"
              className="w-full bg-transparent outline-none"
            />
          </label>
          <div className="grid gap-4 xl:grid-cols-2">
            {visible.map((user) => (
              <UserCard key={user.id} user={user} roles={roles.data ?? []} mutate={mutate} />
            ))}
          </div>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {roles.data?.map((role) => (
            <Card key={role.id} className="p-5">
              <div className="flex justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-primary">{role.code}</p>
                  <h2 className="mt-1 text-lg font-semibold">{role.name}</h2>
                </div>
                <span className="h-fit rounded-full bg-muted px-2 py-1 text-xs font-semibold">
                  {role.userCount} usuarios
                </span>
              </div>
              <p className="mt-3 min-h-10 text-sm text-muted-foreground">
                {role.description ?? 'Sin descripción.'}
              </p>
              <p className="mt-4 text-xs font-semibold">{role.permissions.length} permisos</p>
              {!role.isSystem && (
                <Can permission="roles.delete">
                  <Button
                    className="mt-4 w-full"
                    variant="outline"
                    onClick={() =>
                      mutate(
                        `/api/admin?resource=roles&id=${encodeURIComponent(role.id)}`,
                        'DELETE',
                      )
                    }
                  >
                    Eliminar rol
                  </Button>
                </Can>
              )}
            </Card>
          ))}
        </div>
      )}
      {tab === 'users' && (
        <Pagination meta={users.meta} pending={users.isFetching} onPage={setPage} />
      )}
      {dialog === 'user' && (
        <UserDialog
          roles={roles.data ?? []}
          close={() => setDialog(null)}
          saved={refresh}
          setNotice={setNotice}
        />
      )}{' '}
      {dialog === 'role' && (
        <RoleDialog
          permissions={permissions.data ?? []}
          close={() => setDialog(null)}
          saved={refresh}
          setNotice={setNotice}
        />
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersRound;
  label: string;
  value: number;
}) {
  return (
    <Card className="flex items-center gap-4 p-4">
      <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
        <Icon size={20} />
      </span>
      <div>
        <strong className="text-2xl">{value}</strong>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </Card>
  );
}
function UserCard({
  user,
  roles,
  mutate,
}: {
  user: User;
  roles: Role[];
  mutate: (
    url: string,
    method: 'PATCH' | 'PUT' | 'DELETE' | 'POST',
    body?: unknown,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState(user.roles.map((role) => role.id));
  const active = !user.deletedAt && user.status === 'ACTIVE';
  return (
    <Card className="p-5">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{user.fullName}</h2>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        <span
          className={`h-fit rounded-full px-2 py-1 text-xs font-bold ${active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}
        >
          {user.deletedAt ? 'ELIMINADO' : user.status}
        </span>
      </div>
      <label className="mt-4 block text-xs font-semibold">
        Roles
        <select
          multiple
          aria-label={`Roles de ${user.fullName}`}
          value={selected}
          onChange={(event) =>
            setSelected(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
          }
          className="mt-1 min-h-24 w-full rounded-xl border bg-background p-2 text-sm"
        >
          {roles.map((role) => (
            <option value={role.id} key={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Can permission="users.assign-roles">
          <Button
            variant="outline"
            disabled={!selected.length || !!user.deletedAt}
            onClick={() =>
              mutate(
                `/api/admin?resource=users&id=${encodeURIComponent(user.id)}&action=roles`,
                'PUT',
                { roleIds: selected },
              )
            }
          >
            <UserRoundCog size={16} />
            Guardar roles
          </Button>
        </Can>
        {user.deletedAt ? (
          <Can permission="users.restore">
            <Button
              onClick={() =>
                mutate(
                  `/api/admin?resource=users&id=${encodeURIComponent(user.id)}&action=restore`,
                  'POST',
                  {},
                )
              }
            >
              Restaurar
            </Button>
          </Can>
        ) : (
          <Can permission="users.update">
            <Button
              variant="ghost"
              onClick={() =>
                mutate(`/api/admin?resource=users&id=${encodeURIComponent(user.id)}`, 'PATCH', {
                  status: active ? 'INACTIVE' : 'ACTIVE',
                })
              }
            >
              {active ? 'Desactivar' : 'Activar'}
            </Button>
          </Can>
        )}
      </div>
    </Card>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useDialog(close);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Equipo"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-2xl font-semibold">{title}</h2>
          <button className="grid size-11 place-items-center" aria-label="Cerrar" onClick={close}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
const field = 'mt-1 h-11 w-full rounded-xl border bg-background px-3';
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-semibold">
      {label}
      {children}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

function UserDialog({
  roles,
  close,
  saved,
  setNotice,
}: {
  roles: Role[];
  close: () => void;
  saved: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UserValues>({ resolver: zodResolver(userSchema), defaultValues: { roleIds: [] } });
  const submit = handleSubmit(async (values) => {
    const response = await sessionFetch('/api/admin?resource=users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: problemText((await response.json()) as Problem) });
      return;
    }
    setNotice({ kind: 'success', text: 'Usuario creado correctamente.' });
    await saved();
  });
  return (
    <Dialog title="Nuevo usuario" close={close}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre" error={errors.firstName?.message}>
          <input className={field} {...register('firstName')} />
        </Field>
        <Field label="Apellido" error={errors.lastName?.message}>
          <input className={field} {...register('lastName')} />
        </Field>
        <Field label="Correo" error={errors.email?.message}>
          <input type="email" className={field} {...register('email')} />
        </Field>
        <Field label="Teléfono" error={errors.phone?.message}>
          <input className={field} {...register('phone')} />
        </Field>
        <Field label="Contraseña temporal" error={errors.password?.message}>
          <input
            type="password"
            autoComplete="new-password"
            className={field}
            {...register('password')}
          />
        </Field>
        <Field label="Roles" error={errors.roleIds?.message}>
          <select
            multiple
            className="mt-1 min-h-28 w-full rounded-xl border bg-background p-2"
            {...register('roleIds')}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </Field>
        <Button className="sm:col-span-2" disabled={isSubmitting}>
          {isSubmitting ? 'Creando…' : 'Crear usuario'}
        </Button>
      </form>
    </Dialog>
  );
}
function RoleDialog({
  permissions,
  close,
  saved,
  setNotice,
}: {
  permissions: Permission[];
  close: () => void;
  saved: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RoleValues>({
    resolver: zodResolver(roleSchema),
    defaultValues: { permissionCodes: [] },
  });
  const groups = Map.groupBy(permissions, (permission) => permission.resource);
  const submit = handleSubmit(async (values) => {
    const response = await sessionFetch('/api/admin?resource=roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: problemText((await response.json()) as Problem) });
      return;
    }
    setNotice({ kind: 'success', text: 'Rol creado correctamente.' });
    await saved();
  });
  return (
    <Dialog title="Nuevo rol" close={close}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Código" error={errors.code?.message}>
            <input placeholder="RECEPCION" className={field} {...register('code')} />
          </Field>
          <Field label="Nombre" error={errors.name?.message}>
            <input className={field} {...register('name')} />
          </Field>
        </div>
        <Field label="Descripción" error={errors.description?.message}>
          <textarea
            className="mt-1 min-h-20 w-full rounded-xl border bg-background p-3"
            {...register('description')}
          />
        </Field>
        <fieldset>
          <legend className="text-sm font-semibold">Permisos</legend>
          {errors.permissionCodes && (
            <p className="text-xs text-danger">{errors.permissionCodes.message}</p>
          )}
          <div className="mt-2 grid max-h-72 gap-3 overflow-y-auto rounded-xl border p-3 sm:grid-cols-2">
            {Array.from(groups).map(([resource, entries]) => (
              <section key={resource}>
                <h3 className="mb-1 text-xs font-bold uppercase text-primary">{resource}</h3>
                {entries.map((permission) => (
                  <label className="flex min-h-9 items-start gap-2 text-xs" key={permission.code}>
                    <input
                      type="checkbox"
                      value={permission.code}
                      className="mt-0.5"
                      {...register('permissionCodes')}
                    />
                    <span>{permission.description || permission.action}</span>
                  </label>
                ))}
              </section>
            ))}
          </div>
        </fieldset>
        <Button className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creando…' : 'Crear rol'}
        </Button>
      </form>
    </Dialog>
  );
}
