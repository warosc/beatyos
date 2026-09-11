import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOptions, loadPage } from './pagination';
import { sessionFetch } from './session-fetch';

vi.mock('./session-fetch', () => ({ sessionFetch: vi.fn() }));
const fetchMock = vi.mocked(sessionFetch);
beforeEach(() => fetchMock.mockReset());

const meta = (hasNext: boolean) => ({
  page: 1,
  limit: 100,
  total: 3,
  totalPages: 2,
  hasNext,
  hasPrevious: false,
});

describe('carga de una página', () => {
  it('devuelve datos y meta tal como llegan', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'p1' }], meta: meta(false) }));
    await expect(loadPage('/api/inventory?resource=products')).resolves.toEqual({
      data: [{ id: 'p1' }],
      meta: meta(false),
    });
  });

  it('convierte el detail del error en algo que la pantalla puede mostrar', async () => {
    fetchMock.mockResolvedValue(Response.json({ detail: 'Sin permisos.' }, { status: 403 }));
    await expect(loadPage('/api/inventory?resource=products')).rejects.toThrow('Sin permisos.');
  });

  it('nunca deja pasar un error sin mensaje', async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 500 }));
    await expect(loadPage('/api/clients')).rejects.toThrow('No se pudieron cargar los datos.');
  });
});

describe('opciones de un selector', () => {
  it('recorre todas las páginas para no ocultar productos elegibles', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: 'p1' }, { id: 'p2' }], meta: meta(true) }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'p3' }], meta: meta(false) }));
    await expect(loadOptions('/api/inventory?resource=products')).resolves.toEqual([
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pages = fetchMock.mock.calls.map(([url]) =>
      new URL(url as string, 'http://local').searchParams.get('page'),
    );
    expect(pages).toEqual(['1', '2']);
  });

  it('conserva los filtros de quien llama y pide el lote máximo', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [], meta: meta(false) }));
    await loadOptions('/api/inventory?resource=products&search=tinte');
    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://local');
    expect(url.pathname).toBe('/api/inventory');
    expect(url.searchParams.get('resource')).toBe('products');
    expect(url.searchParams.get('search')).toBe('tinte');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('se detiene cuando la API deja de anunciar página siguiente', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'p1' }] }));
    await expect(loadOptions('/api/clients')).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
