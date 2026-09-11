import { sessionFetch } from './session-fetch';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
export interface Page<T> {
  data: T[];
  meta?: PageMeta;
}

export async function loadPage<T>(url: string, signal?: AbortSignal): Promise<Page<T>> {
  const response = await sessionFetch(url, { signal });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.detail ?? body.message ?? 'No se pudieron cargar los datos.');
  return body as Page<T>;
}

/** Selectors must not silently lose the items beyond the first API page. */
export async function loadOptions<T>(url: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  const params = new URL(url, 'http://local');
  params.searchParams.set('limit', '100');
  for (let page = 1; ; page++) {
    params.searchParams.set('page', String(page));
    const result = await loadPage<T>(params.pathname + params.search, signal);
    items.push(...result.data);
    if (!result.meta?.hasNext) return items;
  }
}
