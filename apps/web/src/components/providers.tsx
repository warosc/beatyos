'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useEffect, useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }),
  );
  useEffect(() => {
    const changed = () => {
      void queryClient.cancelQueries();
      queryClient.clear();
      location.replace('/login');
    };
    const storage = (event: StorageEvent) => {
      if (event.key === 'beautyos-session-change') changed();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        queryClient.clear();
        location.reload();
      }
    };
    window.addEventListener('storage', storage);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener('pageshow', restored);
    };
  }, [queryClient]);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
