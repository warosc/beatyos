import type { MetadataRoute } from 'next';

/**
 * Manifiesto de la app instalable.
 *
 * Con él, la agenda se instala en el teléfono como una app más —icono en la pantalla de
 * inicio, sin barra del navegador— y puede mostrar avisos del sistema cuando una
 * profesional pide un cambio o la encargada lo aprueba. Abre directamente en la agenda:
 * es lo primero que se mira al llegar al salón.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BeautyOS',
    short_name: 'BeautyOS',
    description: 'Agenda y gestión del salón de belleza.',
    start_url: '/agenda',
    scope: '/',
    display: 'standalone',
    // Sin bloquear la orientación: la tablet del mostrador usa la agenda por profesional en
    // horizontal.
    orientation: 'any',
    background_color: '#faf8f5',
    theme_color: '#8d4635',
    lang: 'es',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Agenda', url: '/agenda' },
      { name: 'Nueva cita', url: '/agenda?new=1' },
      { name: 'Mi día', url: '/mi-dia' },
    ],
  };
}
