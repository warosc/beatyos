'use client';

import { useEffect, useState } from 'react';
import { sessionFetch } from '@/lib/session-fetch';
import { safeReturnPath } from '@/lib/safe-return-path';

export default function SessionPage() {
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void sessionFetch('/api/auth/me').then((response) => {
      if (!active) return;
      if (response.ok)
        location.replace(safeReturnPath(new URLSearchParams(location.search).get('returnTo')));
      else if (response.status === 401) location.replace('/login');
      else setError(true);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="p-8" role="status">
      {error ? (
        <>
          No se pudo renovar la sesión.{' '}
          <button onClick={() => location.reload()}>Reintentar</button>
        </>
      ) : (
        'Renovando sesión…'
      )}
    </div>
  );
}
