'use client';
import { useQuery } from '@tanstack/react-query';
import { loadPage } from './pagination';
export function usePagedList<T>(key: string, url: string, enabled = true) {
  const query = useQuery({
    queryKey: [key, url],
    queryFn: ({ signal }) => loadPage<T>(url, signal),
    enabled,
  });
  return { ...query, data: query.data?.data, meta: query.data?.meta };
}
