'use client';

let renewal: Promise<boolean> | undefined;

/**
 * `force` rota aunque el token siga siendo válido. Sirve cuando los permisos han cambiado:
 * `/api/auth/me` los lee de la base y la interfaz ya ofrece la acción, pero el token aún
 * lleva los de cuando se emitió. Renovarlo trae los actuales.
 */
async function renewSession(force = false): Promise<boolean> {
  // Cookies are shared by tabs. Recheck inside the cross-tab lock before rotating.
  const renew = async () => {
    if (!force) {
      const current = await fetch('/api/auth/me', { cache: 'no-store' });
      if (current.ok) return true;
      if (current.status !== 401) throw new Error('Servicio no disponible');
    }
    const response = await fetch('/api/auth/refresh', { method: 'POST', cache: 'no-store' });
    if (response.status >= 500) throw new Error('Servicio no disponible');
    return response.ok;
  };
  if (!renewal) {
    renewal = (async () => {
      if (navigator.locks) return await navigator.locks.request('beautyos-refresh', renew);
      return renew();
    })().finally(() => {
      renewal = undefined;
    });
  }
  return renewal;
}

/** Retries only an authentication rejection; never retries an ambiguous failed mutation. */
export async function sessionFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    let response = await fetch(url, { ...init, cache: 'no-store' });
    const publicAuth = /^\/api\/auth\/(login|forgot-password|reset-password|logout)$/.test(url);
    if (!publicAuth && response.status === 401 && (await renewSession())) {
      response = await fetch(url, { ...init, cache: 'no-store' });
    }
    // Un 403 puede venir de un token con permisos de antes de un cambio de rol. Se renueva
    // una vez y se repite: el rechazo ocurre antes de escribir nada, así que repetir es
    // seguro, y si vuelve a ser 403 la denegación es real.
    if (!publicAuth && response.status === 403 && (await renewSession(true))) {
      response = await fetch(url, { ...init, cache: 'no-store' });
    }
    if (!publicAuth && response.status === 401 && location.pathname !== '/session') {
      location.replace('/login');
    }
    if (response.status !== 204 && !response.headers.get('content-type')?.includes('json')) {
      return Response.json(
        { message: 'Respuesta inválida del servicio.', detail: 'Respuesta inválida del servicio.' },
        { status: response.ok ? 502 : response.status },
      );
    }
    return response;
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    // Keep the same JSON error contract so forms can release their pending state.
    return Response.json(
      {
        message: 'No se pudo conectar. Comprueba el estado antes de repetir la operación.',
        detail: 'No se pudo conectar. Comprueba el estado antes de repetir la operación.',
      },
      { status: 503 },
    );
  }
}

export function announceSessionChange() {
  try {
    localStorage.setItem('beautyos-session-change', crypto.randomUUID());
  } catch {
    /* Storage may be disabled. */
  }
}
