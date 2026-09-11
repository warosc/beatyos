'use client';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { announceSessionChange, sessionFetch } from '@/lib/session-fetch';
export function LogoutButton() {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    setBusy(true);
    setError('');
    await cache.cancelQueries();
    cache.clear();
    const response = await sessionFetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) {
      setError('No se pudo cerrar la sesión. Reintenta.');
      setBusy(false);
      return;
    }
    announceSessionChange();
    window.location.replace('/login');
  }
  return (
    <>
      <button
        disabled={busy}
        onClick={logout}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-sm hover:bg-muted disabled:opacity-50"
      >
        <LogOut size={19} />
        {busy ? 'Saliendo…' : 'Cerrar sesión'}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
