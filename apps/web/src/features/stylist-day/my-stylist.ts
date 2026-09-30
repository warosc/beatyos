'use client';
import { useQuery } from '@tanstack/react-query';
import { useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';

export const MY_STYLIST_KEY = ['my-stylist'] as const;

export type MyStylist = { id: string; displayName: string };

/** La ficha de profesional del usuario, o `null` si su cuenta no atiende clientas. */
export async function fetchMyStylist(): Promise<MyStylist | null> {
  const response = await sessionFetch('/api/stylists/me');
  if (!response.ok) return null;
  return ((await response.json()) as { data: MyStylist | null }).data ?? null;
}

/**
 * ¿Este usuario atiende clientas? Hace falta el permiso **y** la ficha: la propietaria tiene
 * todos los permisos, pero «Mi día» solo tiene sentido si además trabaja como profesional.
 */
export function useIsStylist(permissions?: readonly string[]) {
  const access = useAccess();
  const own = permissions
    ? permissions.includes('service-tickets.create.own')
    : !!access.user?.permissions.includes('service-tickets.create.own');
  const stylist = useQuery({ queryKey: MY_STYLIST_KEY, enabled: own, queryFn: fetchMyStylist });
  return {
    isStylist: own && !!stylist.data,
    pending: own && stylist.isPending,
    stylist: stylist.data,
  };
}
