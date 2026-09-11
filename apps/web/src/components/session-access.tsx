'use client';

import { createContext, useContext } from 'react';
import type { SessionUser } from '@/lib/auth';

export const SessionContext = createContext<SessionUser | null>(null);
export function useAccess() {
  const user = useContext(SessionContext);
  const can = (...permissions: string[]) =>
    !!user &&
    (user.permissions.includes('*') || permissions.every((p) => user.permissions.includes(p)));
  return { user, can };
}
export function Can({
  permission,
  children,
}: {
  permission: string | string[];
  children: React.ReactNode;
}) {
  const { can } = useAccess();
  return can(...(Array.isArray(permission) ? permission : [permission])) ? children : null;
}
