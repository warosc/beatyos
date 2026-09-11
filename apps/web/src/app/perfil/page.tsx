import { LogoutButton } from '@/components/logout-button';
import { cookies } from 'next/headers';
import { Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ChangePasswordForm } from '@/features/profile/change-password-form';
import type { SessionUser } from '@/lib/auth';

interface Profile extends SessionUser {
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
  locale: string;
  status: string;
  lastLoginAt: string | null;
}

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export default async function ProfilePage() {
  const token = (await cookies()).get('beautyos_access')?.value;
  let profile: Profile | null = null;
  if (token) {
    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (response.ok) profile = ((await response.json()) as { data: Profile }).data;
    } catch {
      /* El estado vacío comunica que la API no está disponible. */
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Tu cuenta</p>
        <h1 className="mt-1 font-display text-4xl font-semibold">Perfil</h1>
      </div>
      {profile ? (
        <>
          <Card className="p-6">
            <div className="flex items-center gap-5">
              <div className="grid size-20 place-items-center rounded-full bg-secondary font-display text-2xl font-bold text-secondary-foreground">
                {profile.firstName[0]}
                {profile.lastName[0]}
              </div>
              <div>
                <h2 className="font-display text-2xl font-semibold">{profile.fullName}</h2>
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail size={15} />
                  {profile.email}
                </p>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold">
              <ShieldCheck size={19} className="text-success" />
              Acceso y permisos
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {profile.roles.map((role) => (
                <span
                  key={role}
                  className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold"
                >
                  {role}
                </span>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {profile.permissions.length} permisos efectivos asignados
            </p>
          </Card>
          <ChangePasswordForm />
        </>
      ) : (
        <Card className="p-8 text-center">
          <UserRound className="mx-auto text-muted-foreground" />
          <h2 className="mt-4 font-semibold">No pudimos cargar tu perfil</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Comprueba que la API esté iniciada e inténtalo nuevamente.
          </p>
        </Card>
      )}
      <LogoutButton />
    </div>
  );
}
