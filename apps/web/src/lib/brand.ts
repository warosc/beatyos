/**
 * Combinaciones de colores que un salón puede elegir (misma lista que `BRAND_THEMES` en la
 * API). Cada una es un bloque `[data-brand='…']` en `globals.css`; aquí solo está lo que
 * necesita el selector para mostrarlas.
 */
export const BRANDS = [
  {
    id: 'terracota',
    label: 'Terracota',
    hint: 'Cálido y clásico',
    swatches: ['oklch(0.48 0.1 35)', 'oklch(0.94 0.025 65)'],
  },
  {
    id: 'menta-rosa',
    label: 'Menta y rosa',
    hint: 'Verde tierno con detalles rosa',
    swatches: ['oklch(0.82 0.09 158)', 'oklch(0.9 0.06 350)'],
  },
  {
    id: 'rosa-menta',
    label: 'Rosa y menta',
    hint: 'Rosa con detalles verde tierno',
    swatches: ['oklch(0.84 0.07 5)', 'oklch(0.9 0.06 160)'],
  },
  {
    id: 'lavanda',
    label: 'Lavanda',
    hint: 'Suave y elegante',
    swatches: ['oklch(0.52 0.13 300)', 'oklch(0.93 0.035 320)'],
  },
] as const;

export type BrandId = (typeof BRANDS)[number]['id'];

export const DEFAULT_BRAND: BrandId = 'terracota';
export const BRAND_COOKIE = 'beautyos_brand';

export const asBrand = (value: string | null | undefined): BrandId | null =>
  BRANDS.some((brand) => brand.id === value) ? (value as BrandId) : null;

/**
 * Pinta la interfaz con los colores del salón y los recuerda en este navegador, para que la
 * pantalla de inicio de sesión —que aún no sabe de qué salón es quien entra— salga ya con
 * ellos la próxima vez.
 */
export function applyBrand(value: string | null | undefined) {
  const brand = asBrand(value) ?? DEFAULT_BRAND;
  document.documentElement.dataset.brand = brand;
  try {
    document.cookie = `${BRAND_COOKIE}=${brand}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* Sin cookies solo se pierde el recuerdo para la pantalla de inicio. */
  }
}
