import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { Providers } from '@/components/providers';
import { asBrand, BRAND_COOKIE, DEFAULT_BRAND } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'BeautyOS', template: '%s · BeautyOS' },
  description: 'Gestión inteligente para salones de belleza.',
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#201d1b' },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Los colores del salón salen ya en el HTML, sin parpadeo: el último salón usado en este
  // navegador o, en una instalación de un solo salón, el que fije `BRAND_THEME`.
  const brand =
    asBrand((await cookies()).get(BRAND_COOKIE)?.value) ??
    asBrand(process.env.BRAND_THEME) ??
    DEFAULT_BRAND;
  return (
    <html lang="es" data-brand={brand} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
